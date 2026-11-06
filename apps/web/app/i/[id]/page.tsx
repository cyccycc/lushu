import { Suspense } from "react";
import { ItineraryDocument } from "@/components/itinerary-document";

export default async function ItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-16 text-muted-foreground">正在打开行程…</main>}>
      <ItineraryDocument id={id} />
    </Suspense>
  );
}
