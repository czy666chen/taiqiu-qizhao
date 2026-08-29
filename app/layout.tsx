import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./admin.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hei8chouka.vercel.app"),
  title: "台球奇招 · 朋友局助手",
  description: "为台球朋友局提供中八、斯诺克、多人追分、奇招抽牌、实时房间与完整战绩。",
  openGraph: {
    title: "台球奇招 · 朋友局助手",
    description: "中八、斯诺克、追分、抽牌与实时房间，一部手机记清整场朋友局。",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "台球奇招朋友局助手" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "台球奇招 · 朋友局助手",
    description: "中八 · 斯诺克 · 多人追分 · 51 张奇招牌",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f0e7" },
    { media: "(prefers-color-scheme: dark)", color: "#07110d" },
  ],
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
