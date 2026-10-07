import './globals.css';

export const metadata = { title: '13 Cards', description: 'Multiplayer 13-card rummy' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
