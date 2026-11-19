import { csvFields, readCsv, suggestCsvMapping, validateCsvMapping } from "./csv.mjs";

export function attachCsvPreview(form) {
  const fileField = form.elements.cdr;
  const submit = form.querySelector('[type="submit"]');
  const preview = form.querySelector("#csv-preview");
  const table = form.querySelector("#csv-preview-table");
  const status = form.querySelector("#csv-preview-status");
  const MiB = 1024 * 1024;
  let selectedColumns = [];
  let revision = 0;
  let submitting = false;

  function feedback(message = "", error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("validation-error", error);
  }

  function update() {
    submit.disabled = true;
    if (!selectedColumns.length) return;
    try {
      const mapping = validateCsvMapping(selectedColumns.map((column) => column.value), selectedColumns.length);
      const count = mapping.filter(Boolean).length;
      feedback(`Vybrané sloupce ${count} z ${mapping.length}`);
      submit.disabled = submitting;
    } catch (error) {
      feedback(error.message, true);
    }
  }

  function render(headers, samples) {
    const mapping = suggestCsvMapping(headers);
    const grid = document.createElement("table");
    grid.innerHTML = '<thead><tr><th scope="col">Sloupec v CSV</th><th scope="col">Ukázkové hodnoty</th><th scope="col">Použít jako</th></tr></thead>';
    const rows = grid.createTBody();
    selectedColumns = headers.map((value, index) => {
      const name = value.trim() || `Sloupec ${index + 1}`;
      const row = rows.insertRow();
      row.insertCell().textContent = name;
      const sampleCell = row.insertCell();
      const values = samples.map((sample) => (sample[index] ?? "").trim()).filter(Boolean).slice(0, 3);
      for (const text of values) {
        const line = document.createElement("span");
        line.textContent = text.length > 100 ? text.slice(0, 97) + "…" : text;
        sampleCell.append(line);
      }
      if (!values.length) sampleCell.textContent = "—";
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Použít sloupec ${name}, pozice ${index + 1}`);
      select.add(new Option("Vynechat", ""));
      for (const { key, label } of csvFields) select.add(new Option(label, key));
      select.add(new Option("Kontext pro AI", "context"));
      select.value = mapping[index];
      select.addEventListener("change", update);
      row.insertCell().append(select);
      return select;
    });
    const scroller = document.createElement("div");
    scroller.className = "csv-table-scroll";
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", "Mapování sloupců CSV");
    scroller.append(grid);
    table.replaceChildren(scroller);
    preview.hidden = false;
    update();
  }

  function clear() {
    revision += 1;
    selectedColumns = [];
    table.replaceChildren();
    preview.hidden = true;
    feedback();
    update();
  }

  fileField.addEventListener("change", async () => {
    clear();
    const request = revision;
    const file = fileField.files[0];
    if (!file) return;
    if (file.size > 64 * MiB) {
      feedback("CSV může mít nejvýše 64 MiB.", true);
      return;
    }
    try {
      const part = file.slice(0, 768 * 1024);
      const [headers, ...samples] = readCsv(new Uint8Array(await part.arrayBuffer()), {
        limit: 6, partial: part.size < file.size,
      });
      if (request !== revision) return;
      if (!headers) throw new Error("Nepodařilo se načíst záhlaví CSV.");
      render(headers, samples);
    } catch (error) {
      if (request === revision) feedback(error.message, true);
    }
  });
  return {
    clear,
    mapping() {
      return validateCsvMapping(selectedColumns.map((column) => column.value), selectedColumns.length);
    },
    setSubmitting(value) {
      submitting = value;
      update();
    },
  };
}
