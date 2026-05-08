import { AppExperience } from "@/src/components/app-experience";

export default async function MonitoringIncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AppExperience initialView="monitoring-incident" resourceId={id} />;
}
