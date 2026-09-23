// One-time V1.0 data migration. Run: node scripts/migrate-v1.js
// 1. Fill transit station coordinates where publicly known; leave the rest null
//    (null => UI shows 暂无可靠交通数据, no fabrication).
// 2. Add demo school coordinates near their station + images/fees fields.
// 3. Create data/store/ seeds (agreements, queue, imports) if missing.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const write = (p, obj) => fs.writeFileSync(path.join(ROOT, p), JSON.stringify(obj, null, 2) + '\n', 'utf8');

// --- Station coordinates (approximate, publicly known geography) ---
const STATION_COORDS = {
  // Singapore
  'SG-SIN-ST-JURONG-EAST': [1.333, 103.742],
  'SG-SIN-ST-CHOA-CHU-KANG': [1.385, 103.744],
  'SG-SIN-ST-YISHUN': [1.429, 103.835],
  'SG-SIN-ST-WOODLANDS': [1.437, 103.788],
  'SG-SIN-ST-BISHAN': [1.351, 103.849],
  'SG-SIN-ST-TOA-PAYOH': [1.333, 103.848],
  'SG-SIN-ST-NOVENA': [1.320, 103.843],
  'SG-SIN-ST-ORCHARD': [1.304, 103.832],
  'SG-SIN-ST-CITY-HALL': [1.293, 103.852],
  'SG-SIN-ST-RAFFLES-PLACE': [1.284, 103.851],
  'SG-SIN-ST-MARINA-BAY': [1.276, 103.855],
  'SG-SIN-ST-NEWTON': [1.313, 103.838],
  'SG-SIN-ST-PASIR-RIS': [1.372, 103.949],
  'SG-SIN-ST-TAMPINES': [1.354, 103.944],
  'SG-SIN-ST-BEDOK': [1.324, 103.930],
  'SG-SIN-ST-PAYA-LEBAR': [1.318, 103.893],
  'SG-SIN-ST-KALLANG': [1.311, 103.871],
  'SG-SIN-ST-BUGIS': [1.300, 103.856],
  'SG-SIN-ST-QUEENSTOWN': [1.294, 103.802],
  'SG-SIN-ST-BUONA-VISTA': [1.307, 103.790],
  'SG-SIN-ST-CLEMENTI': [1.315, 103.765],
  'SG-SIN-ST-BOON-LAY': [1.335, 103.705],
  'SG-SIN-ST-TUAS-LINK': [1.339, 103.637],
  'SG-SIN-ST-HARBOURFRONT': [1.265, 103.821],
  'SG-SIN-ST-CHINATOWN': [1.284, 103.844],
  'SG-SIN-ST-CLARKE-QUAY': [1.289, 103.846],
  'SG-SIN-ST-DHOBY-GHAUT': [1.299, 103.846],
  'SG-SIN-ST-LITTLE-INDIA': [1.306, 103.849],
  'SG-SIN-ST-SERANGOON': [1.350, 103.873],
  'SG-SIN-ST-HOUGANG': [1.371, 103.892],
  'SG-SIN-ST-SENGKANG': [1.392, 103.895],
  'SG-SIN-ST-PUNGGOL': [1.405, 103.902],
  'SG-SIN-ST-HOLLAND-VILLAGE': [1.312, 103.795],
  'SG-SIN-ST-ONE-NORTH': [1.300, 103.788],
  'SG-SIN-ST-KENT-RIDGE': [1.293, 103.784],
  'SG-SIN-ST-BOTANIC-GARDENS': [1.322, 103.815],
  'SG-SIN-ST-TAI-SENG': [1.335, 103.888],
  'SG-SIN-ST-STADIUM': [1.303, 103.875],
  'SG-SIN-ST-BUKIT-PANJANG': [1.379, 103.762],
  'SG-SIN-ST-SIXTH-AVENUE': [1.331, 103.793],
  'SG-SIN-ST-PROMENADE': [1.293, 103.861],
  'SG-SIN-ST-BAYFRONT': [1.282, 103.859],
  'SG-SIN-ST-DOWNTOWN': [1.279, 103.852],
  'SG-SIN-ST-FORT-CANNING': [1.292, 103.844],
  'SG-SIN-ST-STEVENS': [1.320, 103.826],
  'SG-SIN-ST-WOODLANDS-NORTH': [1.448, 103.785],
  'SG-SIN-ST-WOODLANDS-SOUTH': [1.436, 103.791],
  'SG-SIN-ST-LENTOR': [1.393, 103.838],
  'SG-SIN-ST-BRIGHT-HILL': [1.361, 103.832],
  'SG-SIN-ST-UPPER-THOMSON': [1.354, 103.833],
  'SG-SIN-ST-CALDECOTT': [1.338, 103.839],
  'SG-SIN-ST-NAPIER': [1.307, 103.819],
  'SG-SIN-ST-GREAT-WORLD': [1.294, 103.833],
  'SG-SIN-ST-HAVELOCK': [1.287, 103.833],
  'SG-SIN-ST-OUTRAM-PARK': [1.280, 103.839],
  'SG-SIN-ST-MAXWELL': [1.280, 103.845],
  'SG-SIN-ST-SHENTON-WAY': [1.278, 103.850],
  'SG-SIN-ST-GARDENS-BY-THE-BAY': [1.281, 103.865],
  'SG-SIN-ST-MARINE-PARADE': [1.303, 103.905],
  'SG-SIN-ST-BAYSHORE': [1.312, 103.944],
  'SG-SIN-ST-CHANGI-AIRPORT': [1.364, 103.992],
  'SG-SIN-ST-WOODLANDS-CHECKPOINT': [1.445, 103.769],
  'SG-SIN-ST-TUAS-CHECKPOINT': [1.336, 103.637],
  // Shanghai
  'CN-SHA-ST-XINZHUANG': [31.110, 121.385],
  'CN-SHA-ST-SHANGHAI-SOUTH-RAILWAY-STATION': [31.154, 121.430],
  'CN-SHA-ST-XUJIAHUI': [31.195, 121.437],
  'CN-SHA-ST-SOUTH-SHAANXI-ROAD': [31.215, 121.455],
  'CN-SHA-ST-PEOPLES-SQUARE': [31.234, 121.473],
  'CN-SHA-ST-SHANGHAI-RAILWAY-STATION': [31.250, 121.455],
  'CN-SHA-ST-HONGQIAO-RAILWAY-STATION': [31.194, 121.322],
  'CN-SHA-ST-HONGQIAO-AIRPORT-T2': [31.197, 121.326],
  'CN-SHA-ST-ZHONGSHAN-PARK': [31.219, 121.421],
  'CN-SHA-ST-JINGAN-TEMPLE': [31.223, 121.445],
  'CN-SHA-ST-WEST-NANJING-ROAD': [31.230, 121.460],
  'CN-SHA-ST-EAST-NANJING-ROAD': [31.238, 121.484],
  'CN-SHA-ST-LUJIAZUI': [31.239, 121.499],
  'CN-SHA-ST-CENTURY-AVENUE': [31.228, 121.526],
  'CN-SHA-ST-LONGYANG-ROAD': [31.204, 121.557],
  'CN-SHA-ST-ZHANGJIANG-HI-TECH-PARK': [31.205, 121.595],
  'CN-SHA-ST-SONGJIANG-SOUTH-RAILWAY-STATION': [31.011, 121.227],
  'CN-SHA-ST-JIUTING': [31.138, 121.319],
  'CN-SHA-ST-DAPUQIAO': [31.210, 121.468],
  'CN-SHA-ST-JIAOTONG-UNIVERSITY': [31.204, 121.437],
  'CN-SHA-ST-SHANGHAI-LIBRARY': [31.209, 121.444],
  'CN-SHA-ST-XINTIANDI': [31.219, 121.474],
  'CN-SHA-ST-YUYUAN-GARDEN': [31.227, 121.489],
  'CN-SHA-ST-TONGJI-UNIVERSITY': [31.282, 121.503],
  'CN-SHA-ST-WUJIAOCHANG': [31.300, 121.514],
  'CN-SHA-ST-DISNEY-RESORT': [31.144, 121.665],
  'CN-SHA-ST-YUQIAO': [31.183, 121.573],
  'CN-SHA-ST-ORIENTAL-SPORTS-CENTER': [31.154, 121.476],
  'CN-SHA-ST-CAOYANG-ROAD': [31.240, 121.418],
  'CN-SHA-ST-NORTH-JIADING': [31.376, 121.230],
  'CN-SHA-ST-ZHUJIAJIAO': [31.114, 121.052],
  'CN-SHA-ST-ORIENTAL-LAND': [31.095, 121.018],
  'CN-SHA-ST-HONGQIAO-INTERNATIONAL-AIRPORT': [31.198, 121.335],
  'CN-SHA-ST-PUDONG-INTERNATIONAL-AIRPORT': [31.150, 121.808],
  // Beijing
  'CN-BJS-ST-GONGZHUFEN': [39.908, 116.309],
  'CN-BJS-ST-MILITARY-MUSEUM': [39.907, 116.322],
  'CN-BJS-ST-FUXINGMEN': [39.907, 116.356],
  'CN-BJS-ST-XIDAN': [39.907, 116.374],
  'CN-BJS-ST-TIANANMEN-EAST': [39.909, 116.401],
  'CN-BJS-ST-JIANGUOMEN': [39.909, 116.435],
  'CN-BJS-ST-GUOMAO': [39.909, 116.461],
  'CN-BJS-ST-DAWANGLU': [39.908, 116.479],
  'CN-BJS-ST-SIHUI': [39.909, 116.496],
  'CN-BJS-ST-XIZHIMEN': [39.940, 116.355],
  'CN-BJS-ST-GULOU-DAJIE': [39.948, 116.394],
  'CN-BJS-ST-YONGHEGONG': [39.948, 116.417],
  'CN-BJS-ST-DONGZHIMEN': [39.941, 116.433],
  'CN-BJS-ST-CHAOYANGMEN': [39.924, 116.433],
  'CN-BJS-ST-BEIJING-RAILWAY-STATION': [39.903, 116.427],
  'CN-BJS-ST-QIANMEN': [39.899, 116.397],
  'CN-BJS-ST-XUANWUMEN': [39.899, 116.374],
  'CN-BJS-ST-ZHONGGUANCUN': [39.984, 116.316],
  'CN-BJS-ST-HAIDIAN-HUANGZHUANG': [39.976, 116.317],
  'CN-BJS-ST-RENMIN-UNIVERSITY': [39.967, 116.321],
  'CN-BJS-ST-BEIJING-ZOO': [39.938, 116.338],
  'CN-BJS-ST-NATIONAL-LIBRARY': [39.943, 116.323],
  'CN-BJS-ST-BEIJING-SOUTH-RAILWAY-STATION': [39.865, 116.378],
  'CN-BJS-ST-DONGSI': [39.924, 116.417],
  'CN-BJS-ST-NANLUOGUXIANG': [39.937, 116.403],
  'CN-BJS-ST-BEIHAI-NORTH': [39.933, 116.385],
  'CN-BJS-ST-TONGZHOU-BEIGUAN': [39.917, 116.657],
  'CN-BJS-ST-LUCHENG': [39.900, 116.720],
  'CN-BJS-ST-SANYUANQIAO': [39.960, 116.453],
  'CN-BJS-ST-LIANGMAQIAO': [39.949, 116.462],
  'CN-BJS-ST-PANJIAYUAN': [39.875, 116.461],
  'CN-BJS-ST-CAOQIAO': [39.845, 116.350],
  'CN-BJS-ST-CHANGPING': [40.220, 116.231],
  'CN-BJS-ST-CHANGPING-DONGGUAN': [40.221, 116.262],
  'CN-BJS-ST-NANSHAO': [40.206, 116.281],
  'CN-BJS-ST-SHAHE': [40.148, 116.286],
  'CN-BJS-ST-ZHUXINZHUANG': [40.106, 116.298],
  'CN-BJS-ST-LIFE-SCIENCE-PARK': [40.070, 116.291],
  'CN-BJS-ST-XI-ERQI': [40.053, 116.306],
  'CN-BJS-ST-CAPITAL-AIRPORT-T2': [40.078, 116.583],
  'CN-BJS-ST-CAPITAL-AIRPORT-T3': [40.053, 116.613],
  'CN-BJS-ST-DAXING-XINCHENG': [39.727, 116.336],
  'CN-BJS-ST-DAXING-INTERNATIONAL-AIRPORT': [39.510, 116.412],
  'CN-BJS-ST-BEIJING-WEST-RAILWAY-STATION': [39.894, 116.321],
  'CN-BJS-ST-QINGHE-RAILWAY-STATION': [40.037, 116.328],
};

// --- School coords: station coords + small deterministic demo offset ---
const SCHOOL_OFFSETS = {
  'SG-DEMO-001': [0.004, 0.005],
  'SG-DEMO-002': [0.003, -0.004],
  'SG-DEMO-003': [-0.003, 0.004],
  'SG-DEMO-004': [0.005, -0.003],
  'SG-DEMO-005': [-0.004, -0.004],
  'SG-DEMO-006': [0.003, 0.006],
  'SG-DEMO-007': [-0.003, -0.005],
  'SG-DEMO-008': [0.004, 0.003],
  'SH-DEMO-001': [0.004, 0.004],
  'SH-DEMO-002': [-0.003, 0.005],
  'SH-DEMO-003': [0.005, -0.004],
  'SH-DEMO-004': [-0.004, 0.003],
  'SH-DEMO-005': [0.003, -0.005],
  'SH-DEMO-006': [-0.005, 0.002],
  'BJ-DEMO-001': [0.004, -0.003],
  'BJ-DEMO-002': [-0.004, 0.004],
  'BJ-DEMO-003': [0.005, 0.005],
  'BJ-DEMO-004': [-0.003, -0.004],
  'BJ-DEMO-005': [0.004, 0.002],
  'BJ-DEMO-006': [-0.005, -0.003],
};

// 1. Patch locations.json
const loc = read('data/reference/locations.json');
let patchedStations = 0;
for (const st of loc.transitStations) {
  const c = STATION_COORDS[st.id];
  if (c) {
    st.latitude = c[0];
    st.longitude = c[1];
    patchedStations++;
  }
}
write('data/reference/locations.json', loc);
console.log(`stations patched with coords: ${patchedStations} / ${loc.transitStations.length}`);

// 2. Patch demo schools: coords, images, fee fields
const schoolsFile = read('data/demo/schools.json');
for (const s of schoolsFile.schools) {
  const stationId = s.nearest_station_id;
  const sc = STATION_COORDS[stationId];
  const off = SCHOOL_OFFSETS[s.id] || [0, 0];
  const lat = sc ? +(sc[0] + off[0]).toFixed(5) : null;
  const lng = sc ? +(sc[1] + off[1]).toFixed(5) : null;
  s.latitude = lat;
  s.longitude = lng;
  for (const c of s.campuses) {
    c.latitude = lat;
    c.longitude = lng;
  }
  s.images = [];
  // First-year cost fields. Only filled where demo data provides all parts;
  // otherwise null -> frontend shows 资料不足.
  const boardingFee = s.boarding ? Math.round(s.tuition_min * 0.12) : 0;
  const oneTime = Math.round(s.tuition_min * 0.06);
  s.boarding_fee = s.boarding ? boardingFee : null;
  s.one_time_fees = oneTime;
  s.first_year_cost_min = s.tuition_min + boardingFee + oneTime;
  s.first_year_cost_max = s.tuition_max + boardingFee + oneTime;
  s.first_year_note = '演示数据：按学费区间 + 住宿费(12%估算) + 一次性费用(6%估算) 演示计算，真实首年费用以学校正式文件为准。';
}
write('data/demo/schools.json', schoolsFile);
console.log(`schools patched: ${schoolsFile.schools.length}`);

// 3. Create store seeds
const storeDir = path.join(ROOT, 'data', 'store');
fs.mkdirSync(storeDir, { recursive: true });

const agreementsPath = path.join(storeDir, 'agreements.json');
if (!fs.existsSync(agreementsPath)) {
  write('data/store/agreements.json', {
    version: '1.0.0',
    source_note: 'B端代理协议。is_demo=true 的记录为演示数据，不展示任何真实佣金；只有后台明确录入真实协议(is_demo=false)的记录才在 B端展示佣金。',
    agreements: [
      {
        id: 'AGR-DEMO-001',
        institution_id: 'SG-DEMO-001',
        program_id: null,
        agency_scope: 'all',
        accepts_agents: true,
        cooperation_status: 'demo',
        commission_type: null,
        commission_value: null,
        currency: null,
        settlement_cycle: null,
        is_demo: true,
        source_document: null,
        effective_from: null,
        effective_to: null,
        updated_at: '2026-09-22'
      },
      {
        id: 'AGR-DEMO-002',
        institution_id: 'SH-DEMO-001',
        program_id: null,
        agency_scope: 'all',
        accepts_agents: true,
        cooperation_status: 'demo',
        commission_type: null,
        commission_value: null,
        currency: null,
        settlement_cycle: null,
        is_demo: true,
        source_document: null,
        effective_from: null,
        effective_to: null,
        updated_at: '2026-09-22'
      }
    ]
  });
  console.log('seeded agreements (demo only)');
}

const queuePath = path.join(storeDir, 'queue.json');
if (!fs.existsSync(queuePath)) {
  write('data/store/queue.json', { version: '1.0.0', items: [] });
  console.log('seeded empty review queue');
}

const importsPath = path.join(storeDir, 'imports.json');
if (!fs.existsSync(importsPath)) {
  write('data/store/imports.json', { version: '1.0.0', schools: [], history: [] });
  console.log('seeded empty imports store');
}

console.log('migration done');
