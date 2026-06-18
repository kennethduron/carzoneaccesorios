import { redirect } from "next/navigation";
import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { BusinessSettingsCenter } from "@/components/admin/business-settings-center";
import { NotificationPreferencesForm } from "@/components/admin/notification-preferences-form";
import { PushNotificationsDeviceCard } from "@/components/admin/push-notifications-device-card";
import { requirePermission } from "@/lib/auth/session";
import { filterPreferencesForRole } from "@/lib/notifications/accountant-scope";
import { getAdminBusinessSettings } from "@/services/supabase/admin-business-settings.service";
import {
  getAdminNotificationPreferences,
  getAdminNotificationUserPreferences,
} from "@/services/supabase/admin-notification-preferences.service";

export const dynamic = "force-dynamic";

export default async function AdminBusinessSettingsPage() {
  const profile = await requirePermission("admin:access");

  const canManageBusinessSettings = ["business_owner", "admin", "technical_owner"].includes(profile.role);
  const canManageGlobalNotifications = canManageBusinessSettings;
  const allowedNotificationRoles = ["business_owner", "admin", "technical_owner", "contadora", "bodega", "vendedor", "soporte"];

  if (!allowedNotificationRoles.includes(profile.role)) {
    redirect("/sin-permiso");
  }

  const [settings, notificationPreferences, userNotificationPreferences] = await Promise.all([
    canManageBusinessSettings ? getAdminBusinessSettings() : Promise.resolve(null),
    getAdminNotificationPreferences(profile.role === "technical_owner"),
    getAdminNotificationUserPreferences(profile.id, profile.role === "technical_owner"),
  ]);
  const visibleNotificationPreferences = filterPreferencesForRole(notificationPreferences, profile.role);
  const visibleUserNotificationPreferences = userNotificationPreferences.filter((preference) =>
    visibleNotificationPreferences.some((visible) => visible.notification_type === preference.notification_type),
  );

  return (
    <AdminShell title="Configuración empresarial">
      <AdminBackButton />
      <div className="space-y-4">
        {settings ? <BusinessSettingsCenter settings={settings} currentRole={profile.role} /> : null}
        <NotificationPreferencesForm
          preferences={visibleNotificationPreferences}
          userPreferences={visibleUserNotificationPreferences}
          currentRole={profile.role}
          canManageGlobal={canManageGlobalNotifications}
        />
        <PushNotificationsDeviceCard />
      </div>
    </AdminShell>
  );
}
