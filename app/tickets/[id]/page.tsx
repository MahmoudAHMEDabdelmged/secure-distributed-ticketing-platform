import { AppExperience } from "@/src/components/app-experience";

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppExperience initialView="ticket-detail" resourceId={id} />;
}
