# pipeline

Extracts Obvious's server-side turn/context data into `../data/loops.json` (contract: `../SCHEMA.md`).

Run on the project sandbox (needs `PROJECT_ID` / `API_TOKEN` and the preinstalled `obvious` SDK):

```sh
cd pipeline && npm install && npm run extract     # writes ../data/loops.json and validates it
npm run validate                                  # re-validate an existing loops.json
# equivalent, no install needed:
npx tsx pipeline/extract.ts                       # from the agents-visualized root
```

Idempotent: every run re-reads all threads/messages/tasks/memory facts and overwrites the file.
