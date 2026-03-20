# Prisma migrations (MongoDB)

This app uses **MongoDB** as the datasource ([`schema.prisma`](../schema.prisma)). Schema changes are applied with:

```bash
npm run db:deploy
```

Historical SQL migration files that targeted SQLite were removed; they did not apply to the current MongoDB provider. Do not reintroduce SQL migrations for this project unless you switch datasource back to a SQL database.
