import { EditPlan } from "@/components/merchant/plan-form";

export default async function EditPlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditPlan id={id} />;
}
