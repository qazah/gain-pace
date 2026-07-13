# RESUME — garmin-connect-and-fetch (S-01)

**Stan na 2026-07-13:** wszystkie 4 fazy zaimplementowane, zreviewowane (6/6 fixów) i **zweryfikowane
na żywo** w `wrangler dev` przeciw sidecarowi na Cloud Run. `change.md` status = `impl_reviewed`.
Zostało tylko domknięcie: `/10x-archive`.

Commity: `3ba17f9` (p3) → `e8efe26` (p4) → `c9ea592` (epilog) → `a849f97` (review F1–F6)
→ `23036cd` (fixy z weryfikacji live) → `a6bdb35` (odhaczenie rowów).

---

## ✅ Zweryfikowane live (wrangler dev + Cloud Run)
3.6 connect zapisuje sesję+hasło · 3.7 żywe dane · 3.8 sidecar down → cache `stale:true` ·
4.4 end-to-end dashboard · 4.5 brak treningu → pole ręczne · 4.6 „unavailable" + ostatnie dane ·
4.7 spinner cold-start · 4.8 brak regresji · 1.8 crypto round-trip (test Vitest).

## ⏳ Jedyny otwarty row
- **2.8** MFA resume po restarcie sidecara — **nietestowalne** na koncie bez MFA. Zweryfikowane
  konstrukcyjnie (pending blob samowystarczalny, sidecar bezstanowy). Przy `/10x-archive` pokaże się
  jako info-warning — to OK.

---

## Co zrobić dalej

### 1. Archiwizacja (główny krok)
```
/10x-archive garmin-connect-and-fetch
```
2.8 bez SHA → info-warning, nie blokuje.

### 2. (Opcjonalnie) sync historii migracji z remote
Grant nadany ręcznie przez SQL Editor; migracja jest w repo. Żeby zsynchronizować historię:
```
npx supabase db push
```
(GRANT jest idempotentny — bezpieczne.)

---

## ⚠️ Pułapki środowiska (na przyszłe sesje)
- **Supabase (free-tier) usypia po nieaktywności** → DNS `ENOTFOUND` / auth „internal error; reference=…".
  Objaw: cała apka leży (auth + baza). Naprawa: dashboard Supabase → projekt **Gain Pace**
  (ref `nshvigolbzhvvbpbzupu`) → **Restore project**. Klucz anon nie zmienia się przy pauzie.
- **`.dev.vars`** ma już ustawione realne `GARMIN_SIDECAR_URL` (Cloud Run), `GARMIN_SIDECAR_SECRET`
  (z Secret Managera) i `GARMIN_PASSWORD_ENC_KEY`.
- **Recovery na „dziś" bywa puste**, dopóki zegarek nie zsynchronizuje dnia — to nie bug; UI pokazuje
  wtedy komunikat „sync your watch".

## 🔧 Otwarty temat na później (poza S-01)
- scheduled-workout zwraca `null` dla **ukończonego** treningu (dziś „Baza" pokazuje się, bo
  nieukończony). Diagnostyka gotowa: `sidecar/debug/dump-calendar.ts`. Do zbadania osobno.

## Nietknięte brudne ścieżki (świadomie)
`context/foundation/roadmap.md`, `.claude/commands/`, `sidecar/debug/`, `supabase/snippets/`.

Raport z review: `context/changes/garmin-connect-and-fetch/reviews/impl-review.md`.
