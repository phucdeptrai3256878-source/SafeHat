// server.js - Backend Node.js / Express cho SafeHat
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cấu hình vùng an toàn hình tròn (Tâm và Bán kính mét)
let siteSettings = {
  center: [10.7738, 106.6585],
  radius: 300 // mét
};

// Danh sách thiết bị và dữ liệu
let workers = [];
let helmetReadings = {};
let alerts = [];

// Hàm tính khoảng cách giữa 2 tọa độ GPS (trả về mét)
function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Bán kính trái đất tính bằng mét
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Kiểm tra điểm có nằm trong vùng hình tròn an toàn không
function isPointInCircle(point, center, radiusMeters) {
  const [lat, lon] = point;
  const [cLat, cLon] = center;
  const distance = getDistanceFromLatLonInMeters(lat, lon, cLat, cLon);
  return distance <= radiusMeters;
}

// Hàm xử lý dữ liệu chung cho cả API lẫn MQTT
function processHelmetData(data) {
  const { id, name, trade, worn, battery, lat, lon, fallen } = data;
  if (!id) return;

  let worker = workers.find(w => w.id === id);
  if (!worker) {
    worker = {
      id: id,
      name: name || `Công nhân ID ${id}`,
      trade: trade || "Kỹ thuật viên / Thợ chính"
    };
    workers.push(worker);
  }

  const inZone = isPointInCircle([lat, lon], siteSettings.center, siteSettings.radius);

  // 1. Cập nhật trạng thái thiết bị
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

  // 3. Bắn dữ liệu cập nhật và tín hiệu kết nối MQTT xuống toàn bộ trình duyệt qua Socket.io
  io.emit('telemetry_data', { workers, readings: helmetReadings, alerts });
  io.emit('mqtt_device_status', { connected: true });
}

// ==========================================
// API NHẬN DỮ LIỆU TỪ ESP32 (HTTP POST)
// ==========================================
app.post('/api/helmet-ping', (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ error: "Thiếu trường 'id' của mũ!" });
  }

  processHelmetData(req.body);

  const inZone = isPointInCircle([req.body.lat, req.body.lon], siteSettings.center, siteSettings.radius);
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
    geofence: siteSettings
  });
});

// ==========================================
// CẤU HÌNH MQTT CLIENT (Cách B: Local Broker)
// ==========================================
const mqttClient = mqtt.connect('mqtt://test.mosquitto.org:1883');

mqttClient.on('connect', () => {
    console.log('[MQTT] Đã kết nối thành công với Local MQTT Broker!');
    // Subscribe khớp hoàn toàn với topic thiết bị gửi lên
    mqttClient.subscribe('factory/helmets/HELMET_01', (err) => {
        if (!err) {
            console.log('[MQTT] Đã subscribe topic: factory/helmets/HELMET_01');
        }
    });
});

// Khi có tin nhắn từ ESP32 gửi lên broker qua MQTT
mqttClient.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        console.log('[MQTT Received]:', payload);
        processHelmetData(payload);
    } catch (e) {
        console.error('[MQTT Error] Không parse được JSON:', e);
    }
});

// Lắng nghe kết nối Socket.io từ trình duyệt
io.on('connection', (socket) => {
  console.log('[Socket.io] Có trình duyệt vừa kết nối giao diện.');
});

// Chạy server bằng http server thay vì app.listen thông thường
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[SafeHat Server] Đang lắng nghe tại cổng ${PORT}`);
});