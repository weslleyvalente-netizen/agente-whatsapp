"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TreeLeafNode {
  type: "leaf";
  key: string;
  label: string;
}

export interface TreeGroupNode {
  type: "group";
  key: string;
  label: string;
  items: { key: string; label: string }[];
}

export type TreeNode = TreeLeafNode | TreeGroupNode;

interface ConfigTreeNavProps {
  tree: TreeNode[];
  selectedSection: string;
  selectedItem: string | null;
  expanded: Record<string, boolean>;
  onToggleExpanded: (sectionKey: string) => void;
  onSelectLeaf: (sectionKey: string) => void;
  onSelectItem: (sectionKey: string, itemKey: string) => void;
}

export function ConfigTreeNav({
  tree,
  selectedSection,
  selectedItem,
  expanded,
  onToggleExpanded,
  onSelectLeaf,
  onSelectItem,
}: ConfigTreeNavProps) {
  return (
    <nav className="space-y-0.5 text-sm">
      {tree.map((node) => {
        if (node.type === "leaf") {
          const active = selectedSection === node.key;
          return (
            <button
              key={node.key}
              type="button"
              onClick={() => onSelectLeaf(node.key)}
              className={cn(
                "block w-full rounded-md px-3 py-1.5 text-left font-medium",
                active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"
              )}
            >
              {node.label}
            </button>
          );
        }

        const isExpanded = expanded[node.key] ?? false;
        const groupActive = selectedSection === node.key;

        return (
          <div key={node.key}>
            <button
              type="button"
              onClick={() => onToggleExpanded(node.key)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left font-medium text-muted-foreground hover:bg-muted/50",
                groupActive && !isExpanded && "bg-muted/40 text-foreground"
              )}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")} />
              {node.label}
            </button>
            {isExpanded && (
              <div className="ml-3 space-y-px border-l pl-2">
                {node.items.map((item) => {
                  const active = groupActive && selectedItem === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => onSelectItem(node.key, item.key)}
                      className={cn(
                        "block w-full truncate rounded-md px-2.5 py-1 text-left text-[13px]",
                        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50"
                      )}
                      title={item.label}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
