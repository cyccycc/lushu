import type { Metadata } from "next";
import { ShareScreen } from "@/components/share-screen";

export const metadata: Metadata = {
  title: "路书",
  referrer: "no-referrer",
};

export default async function SharePage({ params }: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = await params;
  return <ShareScreen id={id} shareKey={key} />;
}
