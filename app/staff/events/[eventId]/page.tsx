import { AppExperience } from "@/src/components/app-experience";

export default async function StaffEventPanelPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  return <AppExperience initialView="staff-event-panel" resourceId={eventId} />;
}
