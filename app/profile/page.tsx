"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getStoredSession } from "@/src/lib/api-client";
import { getDefaultRouteForRole, normalizeRole } from "@/src/lib/roles";

export default function ProfileRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    const session = getStoredSession();
    const role = normalizeRole(session.user?.role);
    router.replace(session.user ? getDefaultRouteForRole(role) : "/login");
  }, [router]);

  return (
    <main className="main-panel">
      <section className="empty-state">
        <p className="eyebrow">EZbook</p>
        <h2>Redirecting...</h2>
        <p>Taking you to the right dashboard.</p>
      </section>
    </main>
  );
}
