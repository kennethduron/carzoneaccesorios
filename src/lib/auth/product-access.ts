import { redirect } from "next/navigation";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import type { AuthProfile, Permission } from "@/types/auth";

export type ProductCapabilities = {
  read: boolean;
  create: boolean;
  update: boolean;
  importProducts: boolean;
  manageImages: boolean;
  exportProducts: boolean;
  deleteProducts: boolean;
  adjustStock: boolean;
  technicalExports: boolean;
  viewCost: boolean;
};

type ProductCapability = Exclude<keyof ProductCapabilities, "technicalExports" | "viewCost">;

const productCapabilityPermission: Record<ProductCapability, Permission> = {
  read: "products:read",
  create: "products:create",
  update: "products:update",
  importProducts: "products:import",
  manageImages: "products:images_manage",
  exportProducts: "products:export",
  deleteProducts: "products:delete",
  adjustStock: "products:adjust_stock",
};

function hasPermission(profile: AuthProfile, permission: Permission) {
  return hasEffectivePermission(profile.role, profile.permissions, permission, profile.email);
}

export function getProductCapabilities(profile: AuthProfile): ProductCapabilities {
  const hasLegacyManage = hasPermission(profile, "products:manage");
  const capability = (permission: Permission) => hasLegacyManage || hasPermission(profile, permission);

  return {
    read: capability(productCapabilityPermission.read),
    create: capability(productCapabilityPermission.create),
    update: capability(productCapabilityPermission.update),
    importProducts: capability(productCapabilityPermission.importProducts),
    manageImages: capability(productCapabilityPermission.manageImages),
    exportProducts: capability(productCapabilityPermission.exportProducts),
    deleteProducts: capability(productCapabilityPermission.deleteProducts),
    adjustStock:
      capability(productCapabilityPermission.adjustStock) ||
      hasPermission(profile, "inventory:manage"),
    technicalExports:
      profile.role === "technical_owner" ||
      hasPermission(profile, "technical:tools"),
    viewCost:
      profile.role === "technical_owner" ||
      hasLegacyManage ||
      hasPermission(profile, "products:create") ||
      hasPermission(profile, "products:update") ||
      hasPermission(profile, "purchases:read") ||
      hasPermission(profile, "purchases:manage"),
  };
}

export async function requireProductCapability(capability: ProductCapability) {
  const profile = await requireSession();
  if (!getProductCapabilities(profile)[capability]) {
    redirect("/sin-permiso");
  }
  return profile;
}
