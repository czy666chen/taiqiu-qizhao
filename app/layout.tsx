import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./admin.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hei8chouka.vercel.app"),
  title: "台球奇招 · 朋友局助手",
  description: "为台球朋友局提供多人追分、奇招抽牌、完整流水和本地战绩。",
  openGraph: {
    title: "台球奇招 · 朋友局助手",
    description: "追分、抽牌、记流水，一部手机管好整场朋友局。",
    type: "website",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "台球奇招朋友局助手" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "台球奇招 · 朋友局助手",
    description: "多人追分 · 51 张奇招牌 · 完整对局流水",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#07100d",
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
