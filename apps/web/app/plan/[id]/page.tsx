import { PlanStudio } from "@/components/plan-studio";

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlanStudio id={id} />;
}
