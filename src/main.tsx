import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { GamePage } from './pages/Game';
import { PlayerPage, TeamPage } from './pages/TeamPlayer';
import { Home, Leaders, Rankings, Schedule, Teams } from './pages/public';
import { Layout, SeasonProvider } from './shared';
import { Empty, Spinner } from './ui';

// The admin dashboard (and the simulation engine it carries for primetime imports) is loaded only when needed.
const Admin = lazy(() => import('./pages/admin/Admin'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <SeasonProvider>
        <Routes>
          <Route path="/admin/*" element={<Suspense fallback={<Spinner />}><Admin /></Suspense>} />
          <Route path="/setup" element={<Suspense fallback={<Spinner />}><Admin setup /></Suspense>} />
          <Route path="*" element={
            <Layout>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/schedule" element={<Schedule />} />
                <Route path="/games/:id" element={<GamePage />} />
                <Route path="/teams" element={<Teams />} />
                <Route path="/teams/:id" element={<TeamPage />} />
                <Route path="/players/:id" element={<PlayerPage />} />
                <Route path="/rankings" element={<Rankings />} />
                <Route path="/stats" element={<Leaders />} />
                <Route path="*" element={<Empty>Page not found.</Empty>} />
              </Routes>
            </Layout>} />
        </Routes>
      </SeasonProvider>
    </BrowserRouter>
  </StrictMode>,
);
