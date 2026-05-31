---
project: GainPace
created_at: 2026-05-31
platform: Cloudflare Workers
stack: Astro 6 SSR + @astrojs/cloudflare
ci_cd: Cloudflare Workers Builds (Git integration)
status: ready-to-execute
---

# Deploy Plan — GainPace (pierwsze wdrożenie)

## Przegląd

Wdrożenie Astro 6 SSR na Cloudflare Workers via **Cloudflare Workers Builds** — natywna integracja Git Cloudflare, automatyczny deploy na push do `master` bez GitHub Actions.

GitHub Actions (`ci.yml`) pozostaje wyłącznie do linta i build-checka (weryfikacja PR). Deploy należy w całości do Cloudflare.

**Poprawki kodu wykonywane przez agenta (przed deployem):**
1. `wrangler.jsonc` — zmiana `name` z `"10x-astro-starter"` na `"gain-pace"`
2. `tech-stack.md` — zmiana `deployment_target: cloudflare-pages` na `cloudflare-workers`

---

## Etap 1 — Założenie konta Cloudflare i logowanie CLI

> Wykonujesz raz. Jeśli masz już konto, przejdź do kroku 1.4.

### 1.1 Utwórz konto Cloudflare

1. Wejdź na **https://dash.cloudflare.com/sign-up**
2. Wpisz swój adres e-mail i hasło → kliknij **Create Account**
3. Cloudflare wyśle e-mail weryfikacyjny — otwórz go i kliknij link potwierdzający
4. Po zalogowaniu zobaczysz panel główny Cloudflare (Dashboard). W lewym górnym rogu będzie napis „Add a site" — na razie **ignoruj to**, nie dodajesz domeny.

### 1.2 Znajdź swój Account ID

1. Na Dashboardzie kliknij **Workers & Pages** w lewym menu (ikona robota)
2. Zobaczysz pustą listę z napisem „Create your first Worker or Pages project"
3. W prawym górnym rogu strony lub w górnym prawym panelu zobaczysz sekcję **Account ID** — to ciąg 32 znaków, np. `a1b2c3d4e5f6...`
4. Skopiuj go i zapisz w notatniku — będzie potrzebny w Etapie 7

### 1.3 Zaloguj CLI `wrangler` do konta

Uruchom w terminalu:

```bash
npx wrangler login
```

Co się dzieje:
- Wrangler otwiera przeglądarkę z adresem Cloudflare OAuth
- Kliknij **Allow** (lub **Authorize**) na stronie Cloudflare
- Przeglądarka pokaże komunikat `Successfully logged in!` — możesz ją zamknąć
- W terminalu zobaczysz `Successfully logged in.`

### 1.4 Potwierdź, że logowanie zadziałało

```bash
npx wrangler whoami
```

Oczekiwany output (Twoje dane):

```
 ⛅️ wrangler 4.x.x
──────────────────
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email address: twoj@email.com!
┌─────────────────────────────────┬──────────────────────────────────┐
│ Account Name                    │ Account ID                       │
├─────────────────────────────────┼──────────────────────────────────┤
│ Twoje Imię's Account            │ a1b2c3d4e5f6...                  │
└─────────────────────────────────┴──────────────────────────────────┘
```

Skopiuj **Account ID** z tej tabeli.

---

## Etap 2 — Plik `.dev.vars` (lokalne sekrety dla `wrangler dev`)

Utwórz plik `.dev.vars` w głównym folderze projektu (obok `package.json`). Plik nie istnieje — musisz go stworzyć ręcznie. Nie commituj go — jest już w `.gitignore`.

Zawartość pliku:

```
SUPABASE_URL=https://<twoje-id>.supabase.co
SUPABASE_KEY=<twój-anon-key>
```

Gdzie znaleźć te wartości:
- Zaloguj się na **https://supabase.com** → wejdź w swój projekt → **Project Settings** → **API**
- `SUPABASE_URL` — pole **Project URL**, np. `https://xyzabc.supabase.co`
- `SUPABASE_KEY` — pole **anon** **public** (nie `service_role`!)

Po utworzeniu `.dev.vars` uruchom lokalny serwer i przetestuj:

```bash
npm run dev
```

Otwórz `http://localhost:4321` w przeglądarce i sprawdź:
- Strona główna się ładuje
- Rejestracja i logowanie działa
- W terminalu brak czerwonych błędów

---

## Etap 3 — Lokalny dry-run (weryfikacja przed deployem)

Sprawdza, czy projekt poprawnie się buduje i czy wrangler nie zgłasza błędów, **bez wysyłania czegokolwiek** na serwery Cloudflare.

```bash
npm run build
npx wrangler deploy --dry-run --outdir ./dist-preview
```

Sprawdź:
- Output `wrangler` kończy się bez `[ERROR]`
- W folderze `dist-preview/` istnieje plik `_worker.js`
- Jeśli pojawi się ostrzeżenie o `nodejs_compat` — ignoruj, flaga jest już ustawiona w `wrangler.jsonc`

---

## Etap 4 — Ustaw produkcyjne sekrety i wdróż ręcznie (pierwsze wdrożenie)

Pierwsze wdrożenie wykonujesz ręcznie z CLI, żeby zweryfikować konfigurację zanim podepniesz automatyczny pipeline.

### 4.1 Ustaw sekrety w Workers

Dla każdego polecenia terminal zapyta o wartość — wpisz ją i naciśnij Enter. Wartości **nie będą widoczne** w terminalu (jak hasło).

```bash
npx wrangler secret put SUPABASE_URL
```
Wpisz wartość: `https://<twoje-id>.supabase.co`

```bash
npx wrangler secret put SUPABASE_KEY
```
Wpisz wartość: `<twój-anon-key>`

Oczekiwany output po każdym poleceniu:
```
🌀 Creating the secret for the Worker "gain-pace"
✨ Success! Uploaded secret SUPABASE_URL.
```

### 4.2 Wdróż Worker

```bash
npx wrangler deploy
```

Oczekiwany output:

```
⛅️ wrangler 4.x.x
────────────────────
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Worker Startup Time: X ms
Uploaded gain-pace (X.XX sec)
Deployed gain-pace triggers (X.XX sec)
  https://gain-pace.<twój-subdomain>.workers.dev
```

Skopiuj URL — to Twoja aplikacja w produkcji.

---

## Etap 5 — Konfiguracja Cloudflare Dashboard (manualnie, po pierwszym deploymencie)

### 5.1 Wyłącz Auto Minify (KRYTYCZNE — łamie React hydration)

> Cloudflare domyślnie może modyfikować kod HTML/CSS/JS Twojej strony. To niszczy React — komponenty renderują się inaczej po stronie serwera niż w przeglądarce, co powoduje błędy `Hydration mismatch`.

Kroki:
1. Wejdź na **https://dash.cloudflare.com**
2. W lewym menu kliknij **Websites** (ikona globusa) — jeśli nie masz własnej domeny, to ustawienie możesz pominąć na tym etapie i wrócić do niego, gdy będziesz dodawać domenę. Jeśli masz domenę:
   - Kliknij w swoją domenę
   - Lewe menu → **Speed** → **Optimization**
   - Zakładka **Content Optimization**
   - Znajdź sekcję **Auto Minify**
   - Odznacz wszystkie trzy checkboxy: **HTML**, **CSS**, **JavaScript**
   - Kliknij **Save**

> Jeśli aplikacja działa na `workers.dev` (bez własnej domeny), Auto Minify nie jest aktywne dla tej subdomeny — możesz ten krok pominąć do momentu dodania domeny.

### 5.2 Sprawdź Worker w dashboardzie

1. **Cloudflare Dashboard** → **Workers & Pages** w lewym menu
2. Powinieneś zobaczyć Worker o nazwie **gain-pace** na liście
3. Kliknij w niego → zakładka **Deployments** — powinno być widoczne najnowsze wdrożenie ze statusem `Active`

---

## Etap 6 — Weryfikacja produkcji

### 6.1 Sprawdź aplikację w przeglądarce

Otwórz URL z kroku 4.2 (np. `https://gain-pace.abcdef.workers.dev`) w przeglądarce i sprawdź:
- [ ] Strona główna się ładuje (nie ma białej strony ani błędu 500)
- [ ] Logowanie / rejestracja działa
- [ ] Brak czerwonych błędów w **DevTools → Console** (F12 w przeglądarce)

### 6.2 Strumieniuj logi na żywo

W terminalu uruchom:

```bash
npx wrangler tail gain-pace --format pretty
```

Terminal będzie pokazywał każde żądanie do Twojego Workera w czasie rzeczywistym. Wejdź na stronę w przeglądarce i obserwuj — powinny pojawiać się linie `GET / 200`. Zatrzymaj Ctrl+C.

---

## Etap 7 — Cloudflare Workers Builds (automatyczny deploy po każdym push)

> Po tym etapie każdy `git push` do `master` automatycznie buduje i deployuje Worker — bez żadnych dodatkowych akcji z Twojej strony.

### 7.1 Otwórz ustawienia Workers Builds

1. **Cloudflare Dashboard** → **Workers & Pages** → kliknij **gain-pace**
2. Kliknij zakładkę **Settings** (u góry)
3. Szukaj sekcji **Builds** lub przycisku **Connect to Git** — w zależności od wersji dashboardu może być też widoczna zakładka **Builds** na górze strony

   > Jeśli nie widzisz żadnej opcji Git/Builds: wróć do **Workers & Pages** → kliknij **Create** → wybierz **Connect to Git** → na ekranie wyboru projektu zaznacz **Existing Worker** i wybierz `gain-pace`.

### 7.2 Połącz konto GitHub

1. Kliknij **Connect to Git** (lub **Add Connection**)
2. Wybierz **GitHub** jako dostawcę Git
3. Cloudflare przekieruje Cię do GitHub — zaloguj się jeśli trzeba
4. GitHub zapyta o uprawnienia dla Cloudflare — kliknij **Authorize Cloudflare**
5. Wybierz, czy dajesz dostęp do wszystkich repozytoriów czy tylko wybranego — wybierz **Only select repositories** i wskaż repo `gain-pace`
6. Kliknij **Save** i wróć do Cloudflare

### 7.3 Wybierz repozytorium i branch

1. Na liście repozytoriów wybierz **gain-pace**
2. Branch: wybierz **master**
3. Kliknij **Begin setup** lub **Next**

### 7.4 Skonfiguruj build

| Pole | Wartość | Uwagi |
|------|---------|-------|
| **Build command** | `npm run build` | Buduje projekt Astro |
| **Deploy command** | *(zostaw puste)* | Cloudflare czyta `wrangler.jsonc` automatycznie |
| **Root directory** | *(zostaw puste)* | Korzeń repozytorium |
| **Node.js version** | `22` | Zgodna z projektem (`.nvmrc` = 22) |

### 7.5 Ustaw zmienne środowiskowe dla buildu

W sekcji **Environment variables** (widocznej podczas konfiguracji lub potem w Settings → Environment Variables):

| Nazwa | Wartość | Typ |
|-------|---------|-----|
| `SUPABASE_URL` | `https://<twoje-id>.supabase.co` | **Secret** (żeby nie było widoczne w logach) |
| `SUPABASE_KEY` | `<twój-anon-key>` | **Secret** |

> Jeśli budujesz bez tych zmiennych, build się powiedzie (są `optional: true` w schema), ale aplikacja nie będzie działać w produkcji. Sekrety runtime ustawiłeś już w Etapie 4.1 przez `wrangler secret put` — te zmienne są tylko dla procesu budowania.

### 7.6 Zapisz i przetestuj pipeline

1. Kliknij **Save** lub **Deploy** — Cloudflare natychmiast uruchomi pierwszy automatyczny build
2. Przejdź do zakładki **Builds** w swoim Workerze — zobaczysz build ze statusem `In progress`
3. Po kilkudziesięciu sekundach status zmieni się na `Success` lub `Failed`
4. Jeśli `Failed` — kliknij w build, żeby zobaczyć logi z błędem
5. Jeśli `Success` — aplikacja jest wdrożona! Sprawdź URL z Etapu 4.2

### 7.7 Przetestuj automatyczny deploy

Zrób dowolną małą zmianę w repozytorium (np. dodaj spację w README) i pushuj do mastera:

```bash
git add .
git commit -m "test: trigger cloudflare build"
git push origin master
```

Cloudflare Dashboard → gain-pace → Builds — powinien pojawić się nowy build.

---

## Rollback

### Z CLI (szybki)

```bash
# Wróć do poprzedniego wdrożenia
npx wrangler rollback

# Wróć do konkretnej wersji
npx wrangler deployments list          # wyświetla listę z version ID
npx wrangler rollback <version-id>
```

### Z dashboardu

1. **Workers & Pages** → gain-pace → **Deployments**
2. Znajdź poprzednią wersję na liście
3. Kliknij `...` (menu) → **Rollback to this deployment**

> Rollback NIE cofa zmian w bazie danych Supabase — jeśli między wersjami były migracje, schema zostaje nowa.

---

## Ryzyka i mitygacje

| Ryzyko | Likelihood | Mitygacja |
|--------|-----------|-----------|
| `auto_minify` łamie React hydration | Medium | Wyłącz w dashboardzie (Etap 5.1) przy dodawaniu domeny |
| `@supabase/ssr` cookie regression na workerd | Medium | Przetestuj auth przez `wrangler dev` (Etap 2) przed deployem |
| Sekrety runtime nie ustawione przed deployem | High | Wykonaj `wrangler secret put` (Etap 4.1) **przed** `wrangler deploy` |
| CPU >10ms na Free tier (silent fail) | Low | `wrangler dev --inspector-port 9229`; upgrade do Paid ($5/mo) jeśli >8ms CPU |
| Edge routing zwiększa latencję Claude API | Low | Monitoruj `wrangler tail`; skonfiguruj Smart Routing jeśli p95 >8s |

---

## Komendy szybkiego dostępu

```bash
npm run dev                                     # dev server (workerd runtime)
npx wrangler deploy                             # ręczny deploy do produkcji
npx wrangler deploy --dry-run --outdir dist-p   # dry-run bez uploadu
npx wrangler tail gain-pace --format pretty     # logi na żywo
npx wrangler rollback                           # rollback do poprzedniej wersji
npx wrangler secret put KEY                     # ustaw sekret produkcyjny (CLI)
npx wrangler deployments list                   # lista wdrożeń z version ID
npx wrangler whoami                             # sprawdź zalogowane konto
```

---

## Poprawki kodu wykonywane przez agenta

### `wrangler.jsonc`
```diff
- "name": "10x-astro-starter",
+ "name": "gain-pace",
```

### `tech-stack.md` — frontmatter
```diff
- deployment_target: cloudflare-pages
+ deployment_target: cloudflare-workers
```
