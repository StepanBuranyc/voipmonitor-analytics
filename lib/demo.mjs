import { readFileSync } from "node:fs";

const scenarios = [
  ["billing", "negative", "Nejasná položka na faktuře", "Volající reklamuje poplatek za doplňkovou službu.", "Podpora předala požadavek k prověření fakturace."],
  ["outage", "negative", "Opakované výpadky připojení", "Volající hlásí výpadky připojení během odpoledne.", "Podpora založila tiket a předala ho technikovi."],
  ["setup", "positive", "Nastavení přesměrování", "Volající potřebuje přesměrovat linku mimo pracovní dobu.", "Společně vyzkoušeli nastavení a přesměrování funguje."],
  ["changes", "neutral", "Změna kontaktních údajů", "Volající chce změnit kontaktní e-mail pro servisní zprávy.", "Podpora potvrdila změnu v účtu."],
  ["orders", "positive", "Potvrzení nové objednávky", "Volající ověřuje termín aktivace objednané linky.", "Podpora potvrdila termín aktivace."],
  ["access", "mixed", "Obnovení přístupu do účtu", "Volající se po změně hesla nemůže přihlásit.", "Obnovení přístupu bylo zahájeno, potvrzení ještě nedorazilo."],
  ["other", "neutral", "Dotaz na otevírací dobu", "Volající zjišťuje dostupnost technické podpory o víkendu.", "Podpora sdělila provozní dobu."],
  ["billing", "negative", "Nesouhlas s cenou služby", "Volající upozorňuje na rozdíl mezi sjednanou cenou a fakturou.", "Podpora zaznamenala reklamaci a přislíbila kontrolu."],
  ["outage", "mixed", "Přerušovaný zvuk při hovorech", "Volající popisuje výpadky zvuku na odchozích hovorech.", "Podpora si vyžádala příklady hovorů pro diagnostiku."],
];

const branches = ["Praha", "Brno", "Ostrava"];

export function demoData() {
  const demoUrl = new URL("../examples/", import.meta.url);
  const recorded = JSON.parse(readFileSync(new URL("recording.json", demoUrl), "utf8"));
  const sample = readFileSync(new URL("VPM-1001.wav", demoUrl));
  const records = [{
    key: "demo-1001", cdrId: "VPM-1001", sensor: "1", branch: "Praha", startedAt: "2026-10-31 15:42:00",
    duration: recorded.duration, mos: 4.25, jitter: 5.8, loss: 0.2, status: "complete",
    transcript: recorded.segments,
    analysis: {
      title: "Duplicitní poplatek na faktuře",
      topic: "billing",
      sentiment: "mixed",
      summary: "Volající upozornil na duplicitní poplatek. Podpora potvrdila nesrovnalost a zadala opravu faktury.",
      request: "Prověřit duplicitní položku na faktuře.",
      outcome: "Oprava byla zadána. Potvrzení má přijít e-mailem.",
      evidence: [0, 1],
      model: "Fiktivní ukázka",
    },
  }];
  let seed = 75;
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let day = 0; day < 61; day += 1) {
    const date = new Date(Date.UTC(2026, 8, day + 1));
    const lastMonth = date.getUTCMonth() === 9;
    const dateText = date.toISOString().slice(0, 10);
    const isWeekend = [0, 6].includes(date.getUTCDay());
    const volume = isWeekend ? 6 + Math.floor(random() * 9) : 14 + Math.floor(random() * 18 + (lastMonth ? day / 9 : 0));
    for (let index = 0; index < volume; index += 1) {
      const choices = lastMonth
        ? [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 7, 8]
        : [0, 1, 1, 2, 2, 2, 3, 3, 4, 4, 5, 6, 7, 8];
      const [topic, sentiment, title, request, outcome] = scenarios[choices[Math.floor(random() * choices.length)]];
      const id = 1001 + records.length;
      const branch = branches[Math.floor(random() * branches.length)];
      const notAnalyzed = random() < 0.085;
      const hour = String(8 + Math.floor(random() * 7)).padStart(2, "0");
      const minute = String(Math.floor(random() * 60)).padStart(2, "0");
      const duration = 42 + Math.floor(random() * 415);
      records.push({
        key: `demo-${id}`,
        cdrId: `VPM-${id}`,
        sensor: String(branches.indexOf(branch) + 1),
        startedAt: `${dateText} ${hour}:${minute}:00`,
        branch,
        duration,
        mos: Math.round((3.62 + random() * 0.8) * 100) / 100,
        jitter: Math.round((3 + random() * 12) * 10) / 10,
        loss: Math.round(random() * 90) / 100,
        status: notAnalyzed ? "missing_audio" : "complete",
        transcript: notAnalyzed ? null : [
          { seconds: 7.5, end: 12, speaker: "Volající", text: request },
          { seconds: 18, end: 23, speaker: "Podpora", text: outcome },
        ],
        analysis: notAnalyzed ? null : {
          topic, sentiment, title, request, outcome, summary: `${request} ${outcome}`,
          evidence: [0, 1], model: "Fiktivní ukázka",
        },
      });
    }
  }
  return { sample, records };
}
