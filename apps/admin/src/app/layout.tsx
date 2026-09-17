import type { Metadata } from 'next';
import './globals.css';
import './workspace-scroll.css';
import './scrollbar.css';
import { AuthProvider } from '@/context/auth-context';

export const metadata: Metadata = {
  title: 'iRexPro Admin — Back Office',
  description: 'iRexPro platform admin/back-office portal.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
