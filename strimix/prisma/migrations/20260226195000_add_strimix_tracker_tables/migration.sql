-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "streamId" TEXT,
    "serverApiKeyEncrypted" TEXT,
    "cookieName" TEXT NOT NULL DEFAULT 'sx_uid',
    "privacyMode" TEXT NOT NULL DEFAULT 'balanced',
    "clientEventViewProduct" BOOLEAN NOT NULL DEFAULT true,
    "clientEventAddToCart" BOOLEAN NOT NULL DEFAULT true,
    "clientEventRemoveFromCart" BOOLEAN NOT NULL DEFAULT true,
    "clientEventBeginCheckout" BOOLEAN NOT NULL DEFAULT true,
    "serverEventNewOrder" BOOLEAN NOT NULL DEFAULT true,
    "serverEventUpdateOrder" BOOLEAN NOT NULL DEFAULT true,
    "serverEventRefund" BOOLEAN NOT NULL DEFAULT true,
    "debugLogging" BOOLEAN NOT NULL DEFAULT false,
    "lastWebhookReceivedAt" DATETIME,
    "lastWebhookTopic" TEXT,
    "lastWebhookEventId" TEXT,
    "lastServerSendStatus" TEXT,
    "lastServerSendAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'processed',
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OutboundEventDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" INTEGER,
    "lastErrorMessage" TEXT,
    "webhookEventId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'webhook',
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_shop_eventId_key" ON "WebhookDelivery"("shop", "eventId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_shop_topic_idx" ON "WebhookDelivery"("shop", "topic");

-- CreateIndex
CREATE INDEX "OutboundEventDelivery_status_nextAttemptAt_idx" ON "OutboundEventDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundEventDelivery_shop_eventName_idx" ON "OutboundEventDelivery"("shop", "eventName");
