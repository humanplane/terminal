use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
    routing::get,
};
use tower_http::timeout::TimeoutLayer;
use futures_util::{Stream, StreamExt};
use polyoxide_clob::{
    Clob, OrderSide,
    ws::{Channel, MarketMessage, WebSocket},
};
use polyoxide_core::QueryBuilder;
use polyoxide_data::DataApi;
use polyoxide_data::api::leaderboard::{LeaderboardCategory, LeaderboardOrderBy};
use polyoxide_data::types::TimePeriod;
use polyoxide_gamma::Gamma;
use serde::Deserialize;
use tokio_stream::wrappers::ReceiverStream;
use tower_http::{cors::CorsLayer, trace::TraceLayer};

#[derive(Clone)]
struct AppState {
    gamma: Arc<Gamma>,
    clob: Arc<Clob>,
    data: Arc<DataApi>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow::anyhow!("failed to install rustls crypto provider"))?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=debug".into()),
        )
        .init();

    let gamma = Gamma::builder()
        .timeout_ms(15_000)
        .max_concurrent(8)
        .build()?;
    let clob = Clob::public();
    let data = DataApi::builder()
        .timeout_ms(15_000)
        .max_concurrent(8)
        .build()?;

    let state = AppState {
        gamma: Arc::new(gamma),
        clob: Arc::new(clob),
        data: Arc::new(data),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/markets", get(list_markets))
        .route("/api/markets/:cid", get(get_market))
        .route("/api/events", get(list_events))
        .route("/api/search", get(search))
        .route("/api/book/:token_id", get(order_book))
        .route("/api/price/:token_id", get(price))
        .route("/api/history/:token_id", get(price_history))
        .route("/api/stream/:token_id", get(stream_book))
        .route("/api/trades", get(market_trades))
        .route("/api/holders", get(top_holders))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/user/:addr/positions", get(user_positions))
        .route("/api/user/:addr/closed-positions", get(user_closed_positions))
        .route("/api/user/:addr/value", get(user_value))
        .route("/api/user/:addr/trades", get(user_trades))
        .route("/api/user/:addr/activity", get(user_activity))
        .with_state(state)
        .layer(CorsLayer::permissive())
        // Hard cap per request — upstream SDK has its own 15s timeout but
        // axum needs its own, otherwise a stuck upstream pins the tower task.
        .layer(TimeoutLayer::new(Duration::from_secs(20)))
        .layer(TraceLayer::new_for_http());

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 8080));
    tracing::info!("listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> &'static str {
    "ok"
}

/// Accept only the shapes Polymarket ids come in — avoids forwarding
/// path-traversal / arbitrary characters into upstream URLs.
fn valid_id(s: &str, max_len: usize) -> bool {
    !s.is_empty()
        && s.len() <= max_len
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn ensure_id(s: &str, max_len: usize) -> Result<(), AppError> {
    if !valid_id(s, max_len) {
        return Err(AppError(anyhow::anyhow!("invalid identifier")));
    }
    Ok(())
}

#[derive(Deserialize)]
struct MarketsQuery {
    limit: Option<u32>,
    offset: Option<u32>,
    order: Option<String>,
    tag_id: Option<i64>,
    volume_min: Option<f64>,
    closed: Option<bool>,
    slug: Option<String>,
}

async fn list_markets(
    State(s): State<AppState>,
    Query(q): Query<MarketsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut req = s
        .gamma
        .markets()
        .list()
        .limit(q.limit.unwrap_or(50))
        .offset(q.offset.unwrap_or(0))
        .order(q.order.as_deref().unwrap_or("volume24hr"))
        .ascending(false)
        .closed(q.closed.unwrap_or(false));

    if let Some(v) = q.volume_min {
        req = req.volume_num_min(v);
    }
    if let Some(t) = q.tag_id {
        req = req.tag_id(t);
    }
    if let Some(slug) = q.slug.as_deref().filter(|s| !s.is_empty()) {
        req = req.slug(std::iter::once(slug));
    }

    let markets = req.send().await?;
    Ok(Json(serde_json::to_value(markets)?))
}

async fn get_market(
    State(s): State<AppState>,
    Path(cid): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&cid, 128)?;
    let market = s.gamma.markets().get(&cid).send().await?;
    Ok(Json(serde_json::to_value(market)?))
}

#[derive(Deserialize)]
struct EventsQuery {
    limit: Option<u32>,
    offset: Option<u32>,
    active: Option<bool>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    page: Option<u32>,
    limit_per_type: Option<u32>,
}

async fn search(
    State(s): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    if q.q.len() > 200 {
        return Err(AppError(anyhow::anyhow!("query too long")));
    }
    let resp = s
        .gamma
        .search()
        .public_search(q.q)
        .limit_per_type(q.limit_per_type.unwrap_or(30).min(50))
        .page(q.page.unwrap_or(1))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

async fn list_events(
    State(s): State<AppState>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let events = s
        .gamma
        .events()
        .list()
        .limit(q.limit.unwrap_or(30))
        .offset(q.offset.unwrap_or(0))
        .active(q.active.unwrap_or(true))
        .order("volume24hr")
        .ascending(false)
        .send()
        .await?;
    Ok(Json(serde_json::to_value(events)?))
}

async fn order_book(
    State(s): State<AppState>,
    Path(token_id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&token_id, 128)?;
    let book = s.clob.markets().order_book(&token_id).send().await?;
    Ok(Json(serde_json::to_value(book)?))
}

#[derive(Deserialize)]
struct PriceQuery {
    side: Option<String>,
}

async fn price(
    State(s): State<AppState>,
    Path(token_id): Path<String>,
    Query(q): Query<PriceQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&token_id, 128)?;
    let side = match q.side.as_deref() {
        Some("sell") => OrderSide::Sell,
        _ => OrderSide::Buy,
    };
    let p = s.clob.markets().price(&token_id, side).send().await?;
    Ok(Json(serde_json::to_value(p)?))
}

#[derive(Deserialize)]
struct HistoryQuery {
    interval: Option<String>,
    fidelity: Option<u32>,
    start_ts: Option<i64>,
    end_ts: Option<i64>,
}

async fn price_history(
    State(s): State<AppState>,
    Path(token_id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&token_id, 128)?;
    let interval = q.interval.as_deref().unwrap_or("1w");
    let fidelity = q.fidelity.unwrap_or(60);
    let mut req = s
        .clob
        .markets()
        .prices_history(&token_id)
        .query("fidelity", fidelity);
    if let (Some(s), Some(e)) = (q.start_ts, q.end_ts) {
        req = req.query("startTs", s).query("endTs", e);
    } else {
        req = req.query("interval", interval);
    }
    let hist = req.send().await?;
    Ok(Json(serde_json::to_value(hist)?))
}

async fn stream_book(
    Path(token_id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    ensure_id(&token_id, 128)?;
    let (tx, rx) = tokio::sync::mpsc::channel::<Event>(64);

    tokio::spawn(async move {
        // Bounded reconnect: give up after ~20 attempts so a dead token
        // doesn't leave a background task looping forever.
        const MAX_ATTEMPTS: u32 = 20;
        let mut attempts: u32 = 0;
        let mut backoff = Duration::from_secs(1);
        loop {
            if tx.is_closed() {
                return;
            }
            if attempts >= MAX_ATTEMPTS {
                tracing::warn!(
                    token_id = %token_id,
                    "ws giving up after {} attempts",
                    attempts
                );
                return;
            }

            match WebSocket::connect_market(vec![token_id.clone()]).await {
                Ok(mut ws) => {
                    attempts = 0;
                    backoff = Duration::from_secs(1);
                    while let Some(msg) = ws.next().await {
                        let payload = match msg {
                            Ok(Channel::Market(MarketMessage::Book(b))) => {
                                serde_json::json!({ "type": "book", "data": b })
                            }
                            Ok(Channel::Market(MarketMessage::PriceChange(p))) => {
                                serde_json::json!({ "type": "price_change", "data": p })
                            }
                            Ok(Channel::Market(MarketMessage::LastTradePrice(l))) => {
                                serde_json::json!({ "type": "last_trade", "data": l })
                            }
                            Ok(Channel::Market(MarketMessage::TickSizeChange(t))) => {
                                serde_json::json!({ "type": "tick_size", "data": t })
                            }
                            Ok(_) => continue,
                            Err(e) => {
                                tracing::warn!("ws msg error: {e}");
                                break;
                            }
                        };
                        let event = match Event::default().json_data(payload) {
                            Ok(e) => e,
                            Err(e) => {
                                tracing::warn!("sse serialize error: {e}");
                                continue;
                            }
                        };
                        if tx.send(event).await.is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    attempts += 1;
                    tracing::warn!(
                        "ws connect failed ({}/{}): {e}, retry in {:?}",
                        attempts,
                        MAX_ATTEMPTS,
                        backoff
                    );
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    });

    let stream = ReceiverStream::new(rx).map(Ok);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

#[derive(Deserialize)]
struct TradesQuery {
    market: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

async fn market_trades(
    State(s): State<AppState>,
    Query(q): Query<TradesQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    if let Some(m) = q.market.as_deref().filter(|m| !m.is_empty()) {
        ensure_id(m, 128)?;
    }
    let mut req = s
        .data
        .trades()
        .list()
        .limit(q.limit.unwrap_or(50).min(200))
        .offset(q.offset.unwrap_or(0));
    if let Some(m) = q.market.as_deref().filter(|m| !m.is_empty()) {
        req = req.market(std::iter::once(m));
    }
    let resp = req.send().await?;
    Ok(Json(serde_json::to_value(resp)?))
}

#[derive(Deserialize)]
struct HoldersQuery {
    market: String,
    limit: Option<u32>,
    min_balance: Option<u32>,
}

async fn top_holders(
    State(s): State<AppState>,
    Query(q): Query<HoldersQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&q.market, 128)?;
    let resp = s
        .data
        .holders()
        .list(std::iter::once(q.market.as_str()))
        .limit(q.limit.unwrap_or(25).min(500))
        .min_balance(q.min_balance.unwrap_or(1))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

#[derive(Deserialize)]
struct LeaderboardQuery {
    category: Option<String>,
    period: Option<String>,
    order_by: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
}

fn parse_category(s: Option<&str>) -> LeaderboardCategory {
    match s.map(|x| x.to_uppercase()).as_deref() {
        Some("POLITICS") => LeaderboardCategory::Politics,
        Some("SPORTS") => LeaderboardCategory::Sports,
        Some("CRYPTO") => LeaderboardCategory::Crypto,
        Some("CULTURE") => LeaderboardCategory::Culture,
        Some("MENTIONS") => LeaderboardCategory::Mentions,
        Some("WEATHER") => LeaderboardCategory::Weather,
        Some("ECONOMICS") => LeaderboardCategory::Economics,
        Some("TECH") => LeaderboardCategory::Tech,
        Some("FINANCE") => LeaderboardCategory::Finance,
        _ => LeaderboardCategory::Overall,
    }
}

fn parse_period(s: Option<&str>) -> TimePeriod {
    match s.map(|x| x.to_lowercase()).as_deref() {
        Some("day") | Some("1d") => TimePeriod::Day,
        Some("week") | Some("1w") => TimePeriod::Week,
        Some("month") | Some("1m") => TimePeriod::Month,
        _ => TimePeriod::All,
    }
}

fn parse_order_by(s: Option<&str>) -> LeaderboardOrderBy {
    match s.map(|x| x.to_uppercase()).as_deref() {
        Some("VOL") | Some("VOLUME") => LeaderboardOrderBy::Vol,
        _ => LeaderboardOrderBy::Pnl,
    }
}

async fn leaderboard(
    State(s): State<AppState>,
    Query(q): Query<LeaderboardQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let resp = s
        .data
        .leaderboard()
        .get()
        .category(parse_category(q.category.as_deref()))
        .time_period(parse_period(q.period.as_deref()))
        .order_by(parse_order_by(q.order_by.as_deref()))
        .limit(q.limit.unwrap_or(50))
        .offset(q.offset.unwrap_or(0))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

#[derive(Deserialize)]
struct UserListQuery {
    limit: Option<u32>,
    offset: Option<u32>,
}

async fn user_positions(
    State(s): State<AppState>,
    Path(addr): Path<String>,
    Query(q): Query<UserListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&addr, 64)?;
    let resp = s
        .data
        .user(&addr)
        .list_positions()
        .limit(q.limit.unwrap_or(50).min(500))
        .offset(q.offset.unwrap_or(0))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

async fn user_closed_positions(
    State(s): State<AppState>,
    Path(addr): Path<String>,
    Query(q): Query<UserListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&addr, 64)?;
    let resp = s
        .data
        .user(&addr)
        .closed_positions()
        .limit(q.limit.unwrap_or(50).min(500))
        .offset(q.offset.unwrap_or(0))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

async fn user_value(
    State(s): State<AppState>,
    Path(addr): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&addr, 64)?;
    let resp = s.data.user(&addr).positions_value().send().await?;
    Ok(Json(serde_json::to_value(resp)?))
}

async fn user_trades(
    State(s): State<AppState>,
    Path(addr): Path<String>,
    Query(q): Query<UserListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&addr, 64)?;
    let resp = s
        .data
        .user(&addr)
        .trades()
        .limit(q.limit.unwrap_or(30).min(500))
        .offset(q.offset.unwrap_or(0))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

async fn user_activity(
    State(s): State<AppState>,
    Path(addr): Path<String>,
    Query(q): Query<UserListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_id(&addr, 64)?;
    let resp = s
        .data
        .user(&addr)
        .activity()
        .limit(q.limit.unwrap_or(30).min(500))
        .offset(q.offset.unwrap_or(0))
        .send()
        .await?;
    Ok(Json(serde_json::to_value(resp)?))
}

struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        Self(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        tracing::error!("request error: {:#}", self.0);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": self.0.to_string() })),
        )
            .into_response()
    }
}
