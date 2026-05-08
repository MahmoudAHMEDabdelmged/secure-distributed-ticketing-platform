import { AppExperience } from "@/src/components/app-experience";

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppExperience initialView="event-detail" resourceId={id} />;
}
