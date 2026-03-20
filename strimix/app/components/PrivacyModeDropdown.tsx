import { useState, useCallback } from "react";
import { Popover, OptionList, Text } from "@shopify/polaris";
import type { PrivacyMode } from "../lib/settings.server";
import styles from "../styles/settings.module.css";

const OPTIONS: { value: PrivacyMode; label: string }[] = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "disabled", label: "Disabled" },
];

type Props = {
  value: PrivacyMode;
  onChange: (value: PrivacyMode) => void;
};

export function PrivacyModeDropdown({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const selectedLabel = OPTIONS.find((o) => o.value === value)?.label ?? value;

  const handleSelect = useCallback(
    (selected: string[]) => {
      const next = (selected[0] ?? "strict") as PrivacyMode;
      onChange(next);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <Popover
      active={open}
      autofocusTarget="first-node"
      preferredAlignment="left"
      onClose={() => setOpen(false)}
      activator={
        <button
          type="button"
          className={styles.privacyTrigger}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <Text as="span" variant="bodyMd">
            {selectedLabel}
          </Text>
        </button>
      }
    >
      <OptionList
        options={OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        selected={[value]}
        onChange={handleSelect}
      />
    </Popover>
  );
}
