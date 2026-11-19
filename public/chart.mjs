const dateLabel = (day) => `${Number(day.slice(8))}. ${Number(day.slice(5, 7))}.`;

export function setupTrend(canvas, series, tooltip) {
  const chart = canvas.getContext("2d");
  let bounds;
  let hover = null;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !series.length) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    chart.setTransform(scale, 0, 0, scale, 0, 0);
    const width = rect.width;
    const height = rect.height;
    const left = 32;
    const right = width - 12;
    const top = 12;
    const bottom = height - 27;
    const maximum = Math.max(...series.map((item) => item.total), 1);
    const unit = Math.max(1, Math.ceil(maximum / 4));
    const x = (index) => series.length === 1 ? (left + right) / 2 : left + (right - left) * index / (series.length - 1);
    const y = (value) => bottom - (bottom - top) * value / (unit * 4);
    bounds = { left, right, x };

    chart.font = "12px Segoe UI, system-ui, sans-serif";
    chart.textAlign = "right";
    chart.textBaseline = "middle";
    chart.lineWidth = 1;
    for (let step = 0; step <= 4; step += 1) {
      const vertical = y(unit * step);
      chart.strokeStyle = "#e7e7f1";
      chart.beginPath();
      chart.moveTo(left, vertical);
      chart.lineTo(right, vertical);
      chart.stroke();
      chart.fillStyle = "#5b6076";
      chart.fillText(String(unit * step), left - 6, vertical);
    }
    chart.textAlign = "center";
    chart.textBaseline = "top";
    const labels = Math.max(2, Math.min(6, Math.floor(width / 64)));
    const labelIndices = new Set(Array.from({ length: labels }, (_, index) =>
      Math.round(index * (series.length - 1) / (labels - 1))));
    for (const index of labelIndices) {
      const centered = Math.min(width - 19, x(index));
      chart.fillText(dateLabel(series[index].from), centered, bottom + 9);
    }

    const line = (key) => {
      chart.beginPath();
      series.forEach((item, index) => {
        if (index === 0) chart.moveTo(x(index), y(item[key]));
        else chart.lineTo(x(index), y(item[key]));
      });
    };
    if (series.length > 1) {
      line("total");
      chart.lineTo(x(series.length - 1), bottom);
      chart.lineTo(x(0), bottom);
      chart.closePath();
      const fill = chart.createLinearGradient(0, top, 0, bottom);
      fill.addColorStop(0, "#7359ea35");
      fill.addColorStop(1, "#7359ea07");
      chart.fillStyle = fill;
      chart.fill();
    }
    for (const [key, color] of [["total", "#654bda"], ["analyzed", "#158b78"]]) {
      line(key);
      chart.strokeStyle = color;
      chart.lineWidth = key === "total" ? 2.6 : 1.9;
      chart.lineJoin = "round";
      chart.stroke();
      if (series.length === 1 || hover !== null) {
        const selected = hover ?? 0;
        chart.beginPath();
        chart.arc(x(selected), y(series[selected][key]), 3.7, 0, Math.PI * 2);
        chart.fillStyle = color;
        chart.fill();
        chart.strokeStyle = "#fff";
        chart.lineWidth = 1.25;
        chart.stroke();
      }
    }
  }

  const move = (event) => {
    if (!bounds) return;
    const rect = canvas.getBoundingClientRect();
    const horizontal = event.clientX - rect.left;
    const selected = Math.round((horizontal - bounds.left) / (bounds.right - bounds.left) * (series.length - 1));
    const index = Math.max(0, Math.min(series.length - 1, selected));
    if (hover !== index) {
      hover = index;
      draw();
    }
    const item = series[index];
    const label = item.from === item.to ? dateLabel(item.from) : `${dateLabel(item.from)} – ${dateLabel(item.to)}`;
    tooltip.textContent = `${label} · ${item.total} hovorů · ${item.analyzed} analyzováno`;
    tooltip.hidden = false;
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.max(half, Math.min(rect.width - half, bounds.x(index)))}px`;
    tooltip.style.top = `${Math.max(37, event.clientY - rect.top - 10)}px`;
  };
  const leave = () => {
    hover = null;
    tooltip.hidden = true;
    draw();
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerleave", leave);
  const observer = new ResizeObserver(draw);
  observer.observe(canvas);
  draw();
  return () => {
    observer.disconnect();
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerleave", leave);
  };
}
