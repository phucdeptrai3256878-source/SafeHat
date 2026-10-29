// server.js - Backend Node.js / Express cho SafeHat
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// In-Memory Database (hoặc thay bằng PostgreSQL / SQLite)
let siteSettings = {
  geofence: [
    [10.7760, 106.7000],
    [10.7780, 106.7002],
    [10.7782, 106.7025],
    [10.7761, 106.7023]
  ]
};

let workers = [
  { id: "001", name: "Nguyễn Văn An", trade: "Thợ cốt pha" },
  { id: "002", name: "Lê Văn Hùng", trade: "Thợ sắt giàn giáo" }
];

let helmetReadings = {};
let alerts = [];

// Thuật toán Ray-Casting kiểm tra điểm nằm trong đa giác
function isPointInPolygon(point, polygon) {
  const [lat, lon] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > lon) !== (yj > lon)) &&
        (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ==========================================
// API NHẬN DỮ LIỆU TỪ ESP32 THẬT
// POST /api/helmet-ping
// ==========================================
app.post('/api/helmet-ping', (req, res) => {
  const { id, worn, battery, lat, lon, fallen } = req.body;

  if (!id) {
    return res.status(400).json({ error: "Thiếu trường 'id' của mũ!" });
  }

  const inZone = isPointInPolygon([lat, lon], siteSettings.geofence);

  // 1. Cập nhật bảng helmet_readings
  helmetReadings[id] = {
    worker_id: id,
    worn: Boolean(worn),
    battery: Number(battery) || 100,
    lat: Number(lat) || 0.0,
    lon: Number(lon) || 0.0,
    fallen: Boolean(fallen),
    updated_at: new Date().toISOString()
  };

  // 2. Tự động kiểm tra và tạo alert
  if (fallen === true) {
    alerts.unshift({
      id: 'alt_' + Date.now(),
      worker_id: id,
      type: 'TÉ_NGÃ',
      lat,
      lon,
      timestamp: new Date().toISOString(),
      resolved: false
    });
  } else if (worn === false && inZone) {
    // Tháo mũ khi đang ở trong vùng bắt buộc
    const alreadyAlerted = alerts.some(a => a.worker_id === id && a.type === 'THÁO_MŨ' && !a.resolved);
    if (!alreadyAlerted) {
      alerts.unshift({
        id: 'alt_' + Date.now(),
        worker_id: id,
        type: 'THÁO_MŨ',
        lat,
        lon,
        timestamp: new Date().toISOString(),
        resolved: false
      });
    }
  }

  return res.status(200).json({
    status: "success",
    message: "Đã ghi nhận dữ liệu mũ bảo hiểm",
    inZone: inZone
  });
});

// API Đọc dữ liệu cho Dashboard
app.get('/api/dashboard-state', (req, res) => {
  res.json({
    workers,
    readings: helmetReadings,
    alerts,
    geofence: siteSettings.geofence
  });
});

// Chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SafeHat Server] Đang lắng nghe tại cổng ${PORT}`);
});