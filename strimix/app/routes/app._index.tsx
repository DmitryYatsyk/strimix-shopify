import { useState, useEffect, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData, Form } from "react-router";
import {
  Page,
  Card,
  FormLayout,
  TextField,
  Checkbox,
  Button,
  BlockStack,
  Text,
  Box,
  Banner,
  Tooltip,
  Collapsible,
  Icon,
  InlineStack,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronUpIcon } from "@shopify/polaris-icons";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  getOrCreateShopSettings,
  upsertShopSettings,
  type PrivacyMode,
} from "../lib/settings.server";
import {
  ensureStrimixWebPixel,
  requeueFailedOutboundIfConnectionChanged,
} from "../lib/strimix.server";
import { PrivacyModeDropdown } from "../components/PrivacyModeDropdown";
import styles from "../styles/settings.module.css";

function toBool(value: FormDataEntryValue | null) {
  return value === "on";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);
  const themeEditorAppEmbedsUrl = `https://${session.shop}/admin/themes/current/editor?context=apps`;
  return {
    shop: session.shop,
    settings,
    themeEditorAppEmbedsUrl,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const privacyMode = String(
    formData.get("privacyMode") || "strict",
  ) as PrivacyMode;
  const streamId = String(formData.get("streamId") || "").trim();

  const prev = await getOrCreateShopSettings(session.shop);
  try {
    const updated = await upsertShopSettings({
      shop: session.shop,
      enabled: toBool(formData.get("enabled")),
      streamId: streamId || "",
      serverApiKey:
        String(formData.get("serverApiKey") || "").trim() || undefined,
      privacyMode,
      clientEventViewProduct: toBool(formData.get("clientEventViewProduct")),
      clientEventAddToCart: toBool(formData.get("clientEventAddToCart")),
      clientEventRemoveFromCart: toBool(
        formData.get("clientEventRemoveFromCart"),
      ),
      clientEventBeginCheckout: toBool(formData.get("clientEventBeginCheckout")),
      serverEventNewOrder: toBool(formData.get("serverEventNewOrder")),
      serverEventUpdateOrder: toBool(formData.get("serverEventUpdateOrder")),
      serverEventRefund: toBool(formData.get("serverEventRefund")),
    });
    await requeueFailedOutboundIfConnectionChanged(session.shop, prev, updated);
  } catch {
    return { ok: false, error: "Failed to save settings" };
  }

  /** Web Pixel sync: best-effort after DB write (recovery for “pixel already exists” is in ensureStrimixWebPixel). */
  if (streamId && admin) {
    try {
      await ensureStrimixWebPixel(admin, session.shop, {
        streamId,
        privacyMode,
        beginCheckoutEnabled: toBool(formData.get("clientEventBeginCheckout")),
      });
    } catch {
      /* ignore */
    }
  }

  return { ok: true as const };
};

function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString();
}

type AccordionHeaderProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  id: string;
  tooltip?: string;
  tooltipRed?: boolean;
};

function AccordionHeader({
  title,
  open,
  onToggle,
  id,
  tooltip,
  tooltipRed,
}: AccordionHeaderProps) {
  const content = (
    <button
      type="button"
      className={styles.accordionHeader}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={id}
    >
      <span className={styles.accordionHeaderTitle}>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" variant="headingMd" fontWeight="semibold">
            {title}
          </Text>
          {tooltip && (
            <span
              className={tooltipRed ? styles.helpIconRed : styles.helpIcon}
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <Tooltip content={tooltip} preferredPosition="above">
                <span className={styles.helpIconInner} aria-hidden>?</span>
              </Tooltip>
            </span>
          )}
        </InlineStack>
      </span>
      <span className={styles.accordionChevron}>
        <Icon source={open ? ChevronUpIcon : ChevronDownIcon} tone="subdued" />
      </span>
    </button>
  );
  return content;
}

export default function SettingsPage() {
  const { settings, themeEditorAppEmbedsUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const pageTopRef = useRef<HTMLDivElement>(null);

  const [openStatus, setOpenStatus] = useState(false);
  const [openConnection, setOpenConnection] = useState(false);
  const [openPrivacy, setOpenPrivacy] = useState(false);
  const [openEvents, setOpenEvents] = useState(false);

  const [privacyMode, setPrivacyMode] = useState(settings.privacyMode);
  const [serverApiKey, setServerApiKey] = useState("");
  const [streamId, setStreamId] = useState(settings.streamId ?? "");
  const [enabled, setEnabled] = useState(settings.enabled);
  const [clientEventViewProduct, setClientEventViewProduct] = useState(
    settings.clientEventViewProduct,
  );
  const [clientEventAddToCart, setClientEventAddToCart] = useState(
    settings.clientEventAddToCart,
  );
  const [clientEventRemoveFromCart, setClientEventRemoveFromCart] = useState(
    settings.clientEventRemoveFromCart,
  );
  const [clientEventBeginCheckout, setClientEventBeginCheckout] = useState(
    settings.clientEventBeginCheckout,
  );
  const [serverEventNewOrder, setServerEventNewOrder] = useState(
    settings.serverEventNewOrder,
  );
  const [serverEventUpdateOrder, setServerEventUpdateOrder] = useState(
    settings.serverEventUpdateOrder,
  );
  const [serverEventRefund, setServerEventRefund] = useState(
    settings.serverEventRefund,
  );
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);

  useEffect(() => {
    setPrivacyMode(settings.privacyMode);
    setStreamId(settings.streamId ?? "");
    setEnabled(settings.enabled);
    setClientEventViewProduct(settings.clientEventViewProduct);
    setClientEventAddToCart(settings.clientEventAddToCart);
    setClientEventRemoveFromCart(settings.clientEventRemoveFromCart);
    setClientEventBeginCheckout(settings.clientEventBeginCheckout);
    setServerEventNewOrder(settings.serverEventNewOrder);
    setServerEventUpdateOrder(settings.serverEventUpdateOrder);
    setServerEventRefund(settings.serverEventRefund);
  }, [settings]);

  useEffect(() => {
    if (actionData?.ok && pageTopRef.current) {
      pageTopRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [actionData?.ok]);

  const lastErrorMessage = (
    settings as { lastErrorMessage?: string | null }
  ).lastErrorMessage;
  const hasLastError = Boolean(lastErrorMessage);

  const themeEventRows = [
    {
      name: "clientEventBeginCheckout",
      label: "begin_checkout",
      checked: clientEventBeginCheckout,
      set: setClientEventBeginCheckout,
    },
    {
      name: "clientEventViewProduct",
      label: "view_product",
      checked: clientEventViewProduct,
      set: setClientEventViewProduct,
    },
    {
      name: "clientEventAddToCart",
      label: "add_to_cart",
      checked: clientEventAddToCart,
      set: setClientEventAddToCart,
    },
    {
      name: "clientEventRemoveFromCart",
      label: "remove_from_cart",
      checked: clientEventRemoveFromCart,
      set: setClientEventRemoveFromCart,
    },
  ] as const;

  const serverEventRows = [
    {
      name: "serverEventNewOrder",
      label: "new_order",
      checked: serverEventNewOrder,
      set: setServerEventNewOrder,
    },
    {
      name: "serverEventUpdateOrder",
      label: "update_order",
      checked: serverEventUpdateOrder,
      set: setServerEventUpdateOrder,
    },
    {
      name: "serverEventRefund",
      label: "refund",
      checked: serverEventRefund,
      set: setServerEventRefund,
    },
  ] as const;

  return (
    <Page>
      <div ref={pageTopRef} />
      <TitleBar title="Strimix for Shopify" />
      <BlockStack gap="400">
        <Text as="p" variant="bodyMd" tone="subdued">
          Track store events with Strimix. Configure connection, privacy and
          events below.
        </Text>

        {actionData?.ok && (
          <Banner tone="success">Settings saved successfully.</Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical">Failed to save settings.</Banner>
        )}

        {/* 1. Status / Diagnostics – no form fields */}
        <div className={styles.sectionCard}>
          <Card>
            <AccordionHeader
              title="Status / Diagnostics"
              open={openStatus}
              onToggle={() => setOpenStatus((o) => !o)}
              id="collapsible-status"
            />
            <Collapsible id="collapsible-status" open={openStatus}>
              <Box paddingBlockStart="400">
                <BlockStack gap="400">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Last webhook received:{" "}
                    {settings.lastWebhookReceivedAt
                      ? `${formatDateTime(settings.lastWebhookReceivedAt)} — ${settings.lastWebhookTopic ?? ""} ${settings.lastWebhookEventId ?? ""}`
                      : "—"}
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Last Strimix send status:{" "}
                    {settings.lastServerSendStatus ?? "—"}
                    {settings.lastServerSendAt
                      ? ` at ${formatDateTime(settings.lastServerSendAt)}`
                      : ""}
                  </Text>
                  {hasLastError && lastErrorMessage && (
                    <Banner
                      tone="warning"
                      title="Last server send failed"
                      action={{
                        content: errorDetailsOpen ? "Hide details" : "Show details",
                        onAction: () => setErrorDetailsOpen(!errorDetailsOpen),
                      }}
                    >
                      {errorDetailsOpen && (
                        <Text as="p" variant="bodyMd">
                          {lastErrorMessage}
                        </Text>
                      )}
                    </Banner>
                  )}
                </BlockStack>
              </Box>
            </Collapsible>
          </Card>
        </div>

        <Form method="post">
          <input type="hidden" name="privacyMode" value={privacyMode} />
          <input type="hidden" name="enabled" value={enabled ? "on" : ""} />
          <input type="hidden" name="clientEventViewProduct" value={clientEventViewProduct ? "on" : ""} />
          <input type="hidden" name="clientEventAddToCart" value={clientEventAddToCart ? "on" : ""} />
          <input type="hidden" name="clientEventRemoveFromCart" value={clientEventRemoveFromCart ? "on" : ""} />
          <input type="hidden" name="clientEventBeginCheckout" value={clientEventBeginCheckout ? "on" : ""} />
          <input type="hidden" name="serverEventNewOrder" value={serverEventNewOrder ? "on" : ""} />
          <input type="hidden" name="serverEventUpdateOrder" value={serverEventUpdateOrder ? "on" : ""} />
          <input type="hidden" name="serverEventRefund" value={serverEventRefund ? "on" : ""} />

          <BlockStack gap="400">
            {/* 2. Connection */}
            <div className={styles.sectionCard}>
              <Card>
                <AccordionHeader
                  title="Connection"
                  open={openConnection}
                  onToggle={() => setOpenConnection((o) => !o)}
                  id="collapsible-connection"
                  tooltip="This section configures the connection between your Shopify store and Strimix."
                  tooltipRed
                />
                <Collapsible id="collapsible-connection" open={openConnection}>
                  <Box paddingBlockStart="400">
                    <FormLayout>
                      <div className={styles.connectionTopGrid}>
                        <div className={styles.enableTrackingRow}>
                          <Checkbox
                            name="enabled"
                            label="Enable tracking"
                            checked={enabled}
                            onChange={setEnabled}
                          />
                        </div>
                        <div className={`${styles.connectionTopCol2} ${styles.themeEditorButtonWrap}`}>
                          <Button
                            variant="primary"
                            size="slim"
                            url={themeEditorAppEmbedsUrl}
                            target="_blank"
                            external
                            fullWidth
                          >
                            Open Theme Editor (App embeds)
                          </Button>
                        </div>
                      </div>
                      <div className={styles.connectionFieldsRow}>
                        <div className={styles.connectionField}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            Stream ID
                          </Text>
                          <Box paddingBlockStart="100">
                            <div className={styles.inputFieldWrap}>
                              <TextField
                                name="streamId"
                                label="Stream ID"
                                labelHidden
                                value={streamId}
                                onChange={setStreamId}
                                autoComplete="off"
                              />
                            </div>
                          </Box>
                        </div>
                        <div className={styles.connectionField}>
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            Server API Key
                          </Text>
                          <Box paddingBlockStart="100">
                            <div className={styles.inputFieldWrap}>
                              <TextField
                                name="serverApiKey"
                                label="Server API Key"
                                labelHidden
                                value={serverApiKey}
                                onChange={setServerApiKey}
                                autoComplete="off"
                                type="password"
                              />
                            </div>
                          </Box>
                        </div>
                      </div>
                    </FormLayout>
                  </Box>
                </Collapsible>
              </Card>
            </div>

            {/* 3. Privacy mode */}
            <div className={styles.sectionCard}>
              <Card>
                <AccordionHeader
                  title="Privacy mode"
                  open={openPrivacy}
                  onToggle={() => setOpenPrivacy((o) => !o)}
                  id="collapsible-privacy"
                  tooltip="Strict — events are tracked only when explicit consent is given. Balanced — events are tracked until the visitor explicitly declines tracking. Disabled — events are always tracked (developer mode)."
                  tooltipRed
                />
                <Collapsible id="collapsible-privacy" open={openPrivacy}>
                  <Box paddingBlockStart="400">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      Mode
                    </Text>
                    <Box paddingBlockStart="200">
                      <div className={styles.privacyDropdownWrap}>
                        <PrivacyModeDropdown value={privacyMode as PrivacyMode} onChange={setPrivacyMode} />
                      </div>
                    </Box>
                  </Box>
                </Collapsible>
              </Card>
            </div>

            {/* 4. Events */}
            <div className={styles.sectionCard}>
              <Card>
                <AccordionHeader
                  title="Events"
                  open={openEvents}
                  onToggle={() => setOpenEvents((o) => !o)}
                  id="collapsible-events"
                  tooltip="Theme events are collected on the storefront and are required to correctly link server events with the visitor."
                  tooltipRed
                />
                <Collapsible id="collapsible-events" open={openEvents}>
                  <Box paddingBlockStart="400">
                    <InlineStack gap="400" wrap>
                      <div className={styles.eventsGroup}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Theme events
                        </Text>
                        <Box paddingBlockStart="200">
                          <BlockStack gap="200">
                            {themeEventRows.map(({ name, label, checked, set }) => (
                              <div
                                key={name}
                                className={styles.interactiveRow}
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  const target = e.target as HTMLElement;
                                  if (target.closest?.("input[type='checkbox']") || target.closest?.("label")) return;
                                  set((v: boolean) => !v);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    set((v: boolean) => !v);
                                  }
                                }}
                              >
                                <Checkbox
                                  name={name}
                                  label={label}
                                  checked={checked}
                                  onChange={set}
                                />
                              </div>
                            ))}
                          </BlockStack>
                        </Box>
                      </div>
                      <div className={styles.eventsGroup}>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Server events
                        </Text>
                        <Box paddingBlockStart="200">
                          <BlockStack gap="200">
                            {serverEventRows.map(({ name, label, checked, set }) => (
                              <div
                                key={name}
                                className={styles.interactiveRow}
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                  const target = e.target as HTMLElement;
                                  if (target.closest?.("input[type='checkbox']") || target.closest?.("label")) return;
                                  set((v: boolean) => !v);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    set((v: boolean) => !v);
                                  }
                                }}
                              >
                                <Checkbox
                                  name={name}
                                  label={label}
                                  checked={checked}
                                  onChange={set}
                                />
                              </div>
                            ))}
                          </BlockStack>
                        </Box>
                      </div>
                    </InlineStack>
                  </Box>
                </Collapsible>
              </Card>
            </div>

            <Box paddingBlockStart="400">
              <Button submit variant="primary" size="large">
                Save Settings
              </Button>
            </Box>
          </BlockStack>
        </Form>
      </BlockStack>
    </Page>
  );
}
