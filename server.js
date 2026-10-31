// server.js - Backend Node.js / Express cho SafeHat
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Cấu hình vùng an toàn hình tròn (Tâm và Bán kính mét)
let siteSettings = {
  center: [10.7738, 106.6585],
  radius: 300 // mét
};

// Xóa sạch danh sách mẫu để chờ dữ liệu thật từ thiết bị gửi lên
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

// ==========================================
// API NHẬN DỮ LIỆU TỪ ESP32 THẬT
// POST /api/helmet-ping
// ==========================================
app.post('/api/helmet-ping', (req, res) => {
  const { id, name, trade, worn, battery, lat, lon, fallen } = req.body;

  if (!id) {
    return res.status(400).json({ error: "Thiếu trường 'id' của mũ!" });
  }

  // Tự động thêm worker mới vào danh sách nếu thiết bị lần đầu gửi lên
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
    geofence: siteSettings // Trả về thông tin hình tròn để đồng bộ
  });
});

// Chạy server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SafeHat Server] Đang lắng nghe tại cổng ${PORT}`);
});

const mqtt = require('mqtt');

// Kết nối đến Mosquitto MQTT Broker công cộng
const mqttClient = mqtt.connect('mqtt://test.mosquitto.org:1883');

mqttClient.on('connect', () => {
    console.log('[MQTT] Đã kết nối thành công với test.mosquitto.org!');
    // Subscribe đúng topic mà bạn của bạn đang cho ESP32 publish lên
    // (Bạn nhớ hỏi lại bạn mình xem đang dùng chính xác topic gì, ví dụ: "safehat/device/telemetry")
    mqttClient.subscribe('safehat/device/telemetry', (err) => {
        if (!err) {
            console.log('[MQTT] Đã subscribe topic: safehat/device/telemetry');
        }
    });
});

// Khi có tin nhắn từ ESP32 gửi lên broker
mqttClient.on('message', async (topic, message) => {
    try {
        const payload = JSON.parse(message.toString());
        console.log('[MQTT Received]:', payload);

        // payload từ ESP32 gửi lên thường có dạng:
        // { id: "001", name: "Nguyễn Văn An", trade: "Thợ cốt pha", worn: true, battery: 90, lat: 10.7738, lon: 106.6585, fallen: false }

        // Tự động gọi nội bộ logic xử lý như API /api/helmet-ping
        // Hoặc bạn có thể giả lập request gửi vào hệ thống:
        processHelmetData(payload);
    } catch (e) {
        console.error('[MQTT Error] Không parse được JSON:', e);
    }
});

// Hàm xử lý dữ liệu chung cho cả API lẫn MQTT
function processHelmetData(data) {
    const { id, name, trade, worn, battery, lat, lon, fallen } = data;
    if (!id) return;

    let worker = workers.find(w => w.id === id);
    if (!worker) {
        workers.push({
            id: id,
            name: name || `Công nhân ID ${id}`,
            trade: trade || "Thợ chính"
        });
    }

    const inZone = isPointInCircle([lat, lon], siteSettings.center, siteSettings.radius);

    helmetReadings[id] = {
        worker_id: id,
        worn: Boolean(worn),
        battery: Number(battery) || 100,
        lat: Number(lat) || 0.0,
        lon: Number(lon) || 0.0,
        fallen: Boolean(fallen),
        updated_at: new Date().toISOString()
    };

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
}