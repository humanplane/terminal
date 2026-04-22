/* @refresh reload */
import { render } from 'solid-js/web'
import { Navigate, Route, Router } from '@solidjs/router'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import './index.css'
import Shell from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const root = document.getElementById('root')!

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <Router root={Shell}>
        <Route path="/" component={() => <Navigate href="/markets" />} />
        <Route path="/markets" />
        <Route path="/market/:slug" />
        <Route path="/traders" />
        <Route path="/trader/:addr" />
        <Route path="*" component={() => <Navigate href="/markets" />} />
      </Router>
    </QueryClientProvider>
  ),
  root
)
