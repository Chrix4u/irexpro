import type { Metadata } from 'next';
import './globals.css';
import './terminal.css';
import './cockpit.css';
import './terminal-mobile.css';
import './workspace-scroll.css';
import './auth-layout-fixes.css';
import './workspace-pages.css';
import { AuthProvider } from '@/context/auth-context';
import { NotificationProvider } from '@/components/notifications/NotificationProvider';

export const metadata: Metadata = {
  title: 'iRexPro — AI Forex Trading Platform',
  description: 'iRexPro client/trader web app.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <NotificationProvider>
          <AuthProvider>{children}</AuthProvider>
        </NotificationProvider>
      </body>
    </html>
  );
}
