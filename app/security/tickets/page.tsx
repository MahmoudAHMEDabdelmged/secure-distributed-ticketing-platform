import { redirect } from "next/navigation";

export default function SecurityTicketsRedirectPage() {
  redirect("/staff/events");
}
