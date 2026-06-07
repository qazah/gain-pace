---
change_id: domain-schema
title: Domain schema — race_goals, workout_selections, garmin_credentials (RLS)
status: implementing
created: 2026-06-04
updated: 2026-06-04
archived_at: null
---

## Notes

F-01 z @context/foundation/roadmap.md

---

### Checkpoint 2026-06-05 — czekamy na manual verification Phase 1

**Co zostało zrobione:**
- `supabase/migrations/20260604000001_create_domain_tables.sql` — napisany i zaaplikowany
- `npx supabase db reset` — exit code 0 ✓
- Brak nowych regresji lint ✓

**Do zweryfikowania ręcznie (zanim pójdziesz do Phase 2):**

1. Otwórz `http://localhost:54323` → Table Editor
   - Czy widoczne są `race_goals`, `garmin_credentials`, `workout_selections`?
   - Czy kolumny zgadzają się ze schematem z `plan.md`?
2. Auth → Policies — każda tabela powinna mieć 4 polityki (select/insert/update/delete)
3. SQL Editor — test RLS:
   ```sql
   SET LOCAL role = authenticated;
   SET LOCAL "request.jwt.claims" = '{"sub": "00000000-0000-0000-0000-000000000001", "role": "authenticated"}';
   SELECT * FROM garmin_credentials;
   ```
   Oczekiwany wynik: 0 wierszy (RLS działa, nic nie przecieka)

**Jak wrócić jutro:**
```
/10x-implement domain-schema phase 1
```
Agent podbierze stan z `## Progress` w `plan.md` — pierwsze `- [ ]` to 1.3 (manual). Po potwierdzeniu manual verification zrobi commit i zapyta o Phase 2.
