export type AccountHierarchyNode = {
  id: string;
  parent_id: string | null;
};

export function buildAccountChildrenMap(nodes: AccountHierarchyNode[]) {
  const childrenByParent = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (!node.parent_id) continue;

    const children = childrenByParent.get(node.parent_id) ?? new Set<string>();
    children.add(node.id);
    childrenByParent.set(node.parent_id, children);
  }

  return childrenByParent;
}

export function getDescendantAccountIds(nodes: AccountHierarchyNode[], accountId: string) {
  const childrenByParent = buildAccountChildrenMap(nodes);
  const descendants = new Set<string>();
  const pending = [...(childrenByParent.get(accountId) ?? [])];

  while (pending.length > 0) {
    const childId = pending.pop();
    if (!childId || descendants.has(childId)) continue;

    descendants.add(childId);
    pending.push(...(childrenByParent.get(childId) ?? []));
  }

  return descendants;
}

export function wouldCreateAccountCycle(
  nodes: AccountHierarchyNode[],
  accountId: string | null | undefined,
  parentId: string | null | undefined,
) {
  if (!accountId || !parentId) return false;
  if (accountId === parentId) return true;

  return getDescendantAccountIds(nodes, accountId).has(parentId);
}
