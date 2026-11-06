import type { Metadata } from "next";
import { RoadbookScreen } from "@/components/roadbook-screen";

export const metadata: Metadata = {
  title: "路书",
  referrer: "no-referrer",
};

export default async function RoadbookPage({ params }: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = await params;
  return <RoadbookScreen id={id} accessKey={key} />;
}
