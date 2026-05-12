import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UniAttend | Biometric Attendance System",
  description: "Advanced hardware-free biometric attendance system with GPS geofencing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
