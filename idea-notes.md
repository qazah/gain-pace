# Idea Notes: Adaptacyjny Trener Biegowy AI (Working Title: FlexPace / RunShift)

## 1. Główny Problem (The Core Problem)
Tradycyjne plany treningowe (w tym dedykowane plany Garmin Coach) są skrajnie sztywne. Nie biorą pod uwagę dynamicznie zmieniających się warunków dnia codziennego użytkownika, takich jak:
* Złe samopoczucie, niedosypianie (niski poziom regeneracji).
* Brak czasu (nagłe spotkanie w pracy, obowiązki domowe).
* Chęć spontanicznej zmiany (ochota na szybszy bieg zamiast nudnego rozbiegania).

W obecnych systemach modyfikacja treningu "w locie" powoduje rozjechanie się całego planu lub utratę kontekstu (zegarek nie mówi nam, co tracimy lub zyskujemy, zmieniając założenia trenera). Bieganie powinno być elastyczne, ale wciąż prowadzić do określonego celu.

---

## 2. Wizja Produktu (Product Vision)
Aplikacja webowa działająca jako inteligentny "asystent trenera". Pobiera dane z zegarka Garmin (w tym dane o regeneracji/śnie), zna cel długoterminowy i pozwala użytkownikowi dostosować dzisiejszy trening za pomocą prostych modyfikatorów (np. "mam mało czasu", "chcę szybciej"). AI generuje alternatywne opcje treningowe i tłumaczy ich wpływ na formę.

---

## 3. Zakres MVP (Minimum Viable Product)

### Funkcjonalności w MVP:
* **Integracja z Garmin Connect:** Pobieranie danych z ostatnich treningów oraz podstawowych metryk regeneracji (np. jakość snu z ostatniej nocy, o ile dostępna przez bibliotekę wrapper API).
* **Prosty Interfejs Modyfikacji:** Formularz/przyciski pozwalające określić bieżący stan lub chęci użytkownika:
  * *Czas:* [Mam mało czasu / Standardowo]
  * *Intensywność:* [Szybciej / Wolniej / Regeneracyjnie]
  * *Samopoczucie:* [Czuję się świetnie / Jestem zmęczony]
* **AI Workout Generator (Prompt-based):** Integracja z LLM (np. OpenAI API / Gemini API). Prompt przesyła kontekst (ostatnie treningi, sen) oraz preferencje z interfejsu.
* **3 Rekomendacje od AI:** Model zwraca 3 opcje do wyboru na dziś wraz z krótkim, tekstowym uzasadnieniem ("co zyskasz"):
  1. *Opcja Baza* (tlenowa, spokojna).
  2. *Opcja Akcent* (interwały / tempo - dopasowane do stopnia wypoczęcia).
  3. *Opcja Skrócona / Regeneracyjna* (gdy brakuje czasu/sił).

### Poza zakresem MVP (Post-MVP / Future Releases):
* Dwukierunkowa integracja z Garminem (automatyczne wgrywanie wybranego treningu `.fit` bezpośrednio do kalendarza w zegarku).
* Integracja ze Strava API Webhooks.
* Rygorystyczny algorytm matematyczny wyliczający *Training Load* (zastąpiony w MVP przez analizę kontekstową LLM).
* Generowanie całego, 12-tygodniowego planu od zera.

---

## 4. Kryteria Sukcesu (Success Criteria)

1. **Kryterium Techniczne (AI):** LLM stabilnie generuje poprawnie sformatowane plany treningowe (np. w formacie JSON do łatwego wyświetlenia na froncie) i nie halucynuje nierealnych obciążeń (np. 30 km sprintu dla początkującego).
2. **Kryterium Integracji:** Skuteczne pobranie i sparsowanie danych z konta Garmin za pomocą bibliotek zewnętrznych (np. `garminconnect` w Pythonie) bez autoryzacji korporacyjnej.
3. **Kryterium Użyteczności (UX):** Użytkownik potrafi w trzech kliknięciach zmienić swój pierwotny plan na dopasowaną alternatywę i rozumie, dlaczego AI zaproponowało dany zestaw.

---

## 5. Proponowany Stack Technologiczny

* **Backend:** Python (FastAPI lub Flask) – idealny do szybkiego spięcia bibliotek Garmina oraz SDK do OpenAI/Gemini.
* **Frontend:** React.js / Vue.js lub prosty Streamlit/Gradio (jeśli priorytetem jest czyste AI na kurs, a nie zaawansowany design).
* **AI Core:** LangChain / bezpośrednie API do LLM z wymuszeniem strukturyzowanego outputu (Structured Outputs / JSON Mode).