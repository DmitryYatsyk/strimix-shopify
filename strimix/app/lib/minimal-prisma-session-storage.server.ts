/**
 * Prisma session storage without OAuth `state`, `isOnline`, or merchant PII in the database.
 * Reconstructs in-memory {@link Session} with `state: ""` and `isOnline` inferred from id (`offline_*` = offline).
 *
 * See Shopify's default adapter (writes many more fields):
 * node_modules/@shopify/shopify-app-session-storage-prisma/dist/cjs/prisma.js
 */

import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import type { PrismaClient } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

const UNIQUE_KEY_CONSTRAINT_ERROR_CODE = "P2002";

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type SessionRow = {
  id: string;
  shop: string;
  scope: string | null;
  expires: Date | null;
  accessToken: string;
  locale: string | null;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
};

export class MinimalPrismaSessionStorage<T extends PrismaClient>
  implements SessionStorage
{
  private readonly prisma: T;
  private ready: Promise<boolean>;
  private readonly tableName = "session";
  private connectionRetries = 2;
  private connectionRetryIntervalMs = 5000;

  constructor(
    prisma: T,
    options?: { connectionRetries?: number; connectionRetryIntervalMs?: number },
  ) {
    this.prisma = prisma;
    if (options?.connectionRetries !== undefined) {
      this.connectionRetries = options.connectionRetries;
    }
    if (options?.connectionRetryIntervalMs !== undefined) {
      this.connectionRetryIntervalMs = options.connectionRetryIntervalMs;
    }
    if (this.getSessionTable() === undefined) {
      throw new Error(`PrismaClient does not have a ${this.tableName} table`);
    }
    this.ready = this.pollForTable()
      .then(() => true)
      .catch(() => false);
  }

  async storeSession(session: Session): Promise<boolean> {
    await this.ensureReady();
    const data = this.sessionToRow(session);
    try {
      await this.getSessionTable().upsert({
        where: { id: session.id },
        update: data,
        create: data,
      });
    } catch (error) {
      if (
        error instanceof PrismaClientKnownRequestError &&
        error.code === UNIQUE_KEY_CONSTRAINT_ERROR_CODE
      ) {
        await this.getSessionTable().upsert({
          where: { id: session.id },
          update: data,
          create: data,
        });
        return true;
      }
      throw error;
    }
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    await this.ensureReady();
    const row = await this.getSessionTable().findUnique({
      where: { id },
    });
    if (!row) return undefined;
    return this.rowToSession(row as SessionRow);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.ensureReady();
    try {
      await this.getSessionTable().delete({ where: { id } });
    } catch {
      return true;
    }
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await this.ensureReady();
    await this.getSessionTable().deleteMany({ where: { id: { in: ids } } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    await this.ensureReady();
    const sessions = await this.getSessionTable().findMany({
      where: { shop },
      take: 25,
      orderBy: [{ expires: "desc" }],
    });
    return sessions.map((s: SessionRow) => this.rowToSession(s));
  }

  async isReady(): Promise<boolean> {
    try {
      await this.pollForTable();
      this.ready = Promise.resolve(true);
    } catch {
      this.ready = Promise.resolve(false);
    }
    return this.ready;
  }

  private async ensureReady(): Promise<void> {
    if (!(await this.ready)) {
      throw new Error(
        "Prisma session storage is not ready. Check DATABASE_URL and run prisma db push.",
      );
    }
  }

  private async pollForTable(): Promise<void> {
    for (let i = 0; i < this.connectionRetries; i++) {
      try {
        await this.getSessionTable().count();
        return;
      } catch {
        await sleep(this.connectionRetryIntervalMs);
      }
    }
    throw new Error(
      `The table \`${this.tableName}\` does not exist in the current database.`,
    );
  }

  private sessionToRow(session: Session): SessionRow {
    const o = session.toObject();
    const locale =
      o.onlineAccessInfo?.associated_user &&
      typeof o.onlineAccessInfo.associated_user.locale === "string"
        ? o.onlineAccessInfo.associated_user.locale
        : null;

    return {
      id: session.id,
      shop: session.shop,
      scope: session.scope ?? null,
      expires: session.expires ?? null,
      accessToken: session.accessToken ?? "",
      refreshToken: session.refreshToken ?? null,
      refreshTokenExpires: session.refreshTokenExpires ?? null,
      locale,
    };
  }

  private rowToSession(row: SessionRow): Session {
    const isOnline = !row.id.startsWith("offline_");
    const entries: [string, string | number | boolean][] = [
      ["id", row.id],
      ["shop", row.shop],
      ["state", ""],
      ["isOnline", isOnline],
    ];
    if (row.scope) entries.push(["scope", row.scope]);
    if (row.expires) entries.push(["expires", row.expires.getTime()]);
    if (row.accessToken) entries.push(["accessToken", row.accessToken]);
    if (row.refreshToken) entries.push(["refreshToken", row.refreshToken]);
    if (row.refreshTokenExpires) {
      entries.push(["refreshTokenExpires", row.refreshTokenExpires.getTime()]);
    }
    if (row.locale) entries.push(["locale", row.locale]);
    return Session.fromPropertyArray(entries, false);
  }

  private getSessionTable() {
    return (this.prisma as unknown as PrismaClient).session;
  }
}
