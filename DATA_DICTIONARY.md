# DATA_DICTIONARY — V0.5 数据字典

> 本文件描述当前仓库数据模型。所有 `data/demo/*` 为演示数据；`data/reference/*` 为分类字典（非学校数据）。

## 1. 文件布局
```
data/
  reference/
    locations.json        国家 / 城市 / 行政区 / 地铁线路 / 站点
    curricula.json        课程族 + 课程条目
    languages.json        教学语言 + 学校类型
    education-stages.json 教育阶段
  demo/
    schools.json          20 条演示学校（Institution + Campus）
    programs.json         40 条演示课程 / 项目
    scholarships.json     演示奖学金
```

## 2. reference 字典

### locations.json
- `countries`: { id, code, name_zh, name_en, currency, timezone }
- `cities`: { id, country_id, name_zh, name_en }
- `districts`: { id, city_id, region_group, name_zh, name_en }
- `transitLines`: { id, city_id, code, name_zh, name_en, type }
- `transitStations`: { id, line_id, name_zh, name_en, latitude, longitude }

### education-stages.json
- `educationStages`: { id, zh, en, order }（preschool → phd，10 项）

### curricula.json
- `curriculumFamilies`: { id, name_zh, name_en, source }
- `curricula`: { id, family_id, name_zh, name_en, aliases[], stages[] }

### languages.json
- `languages`: { id, name_zh, name_en, code }
- `institutionTypes`: { id, name_zh, name_en }

## 3. demo 实体

### schools.json → schools[]
对齐 `V0.5_SPEC.md` 的 Institution / Campus：
- `id`（如 `SG-DEMO-001`）、`name_zh`、`name_en`
- `country_id` / `city_id` / `district_id`（外键到 reference）
- `institution_type`、`stages[]`、`curricula[]`、`main_language`、`additional_languages[]`
- `tuition_min` / `tuition_max` / `currency`
- `boarding`、`scholarships`
- `nearest_station_id`（外键到 transitStations）
- `latitude` / `longitude`
- `source_url: null`、`source_type`、`verified_status: "demo"`、`verified_at`、`effective_from`、`effective_to`、`is_demo: true`、`updated_at`
- `campuses[]`：{ id, name, address, district_id, latitude, longitude, nearest_station_id }

### programs.json → programs[]
- `id`（如 `SG-DEMO-001-P1`）、`institution_id`、`campus_id`、`name`、`name_zh`
- `stage`、`curriculum`、`duration`、`tuition`、`currency`、`start_date`、`deadline`、`language_requirement`、`scholarship_available`
- `source_url`、`verified_status`

### scholarships.json → scholarships[]
- `id`、`institution_id`、`program_id`、`name`、`type`、`amount`、`currency`、`percentage`、`eligibility`、`deadline`、`certainty`、`source_url`、`verified_status`

## 4. 数据质量规则
- 真实学校必须有 `source_url` 或供应商证明。
- `is_demo=true` 必须前端显示「演示」。
- `verified_status` ∈ { draft, pending, verified, expired, rejected }。
- 学费 / 截止日期 / 奖学金 / 招生要求必须带 `verified_at`。
- 过期信息（effective_to 已过）不得作为当前事实展示。
- 禁止用 AI 猜测或补全学校事实、佣金协议、录取概率。

## 5. 当前数据规模
- 学校：20（SG 7 / 上海 7 / 北京 6）
- 课程：40
- 奖学金：若干（与 institution 关联）
- 参考：3 国、3 城、77 行政区、10 阶段、50+ 课程、15 语言、若干地铁线路/站点
