const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const RAGIC_API_KEY = process.env.RAGIC_API_KEY;
const RAGIC_BASE_URL = 'https://ap9.ragic.com';
const RAGIC_AP = 'proagent';
const FORM_PATH = '/forms/3';
const PORT = process.env.PORT || 8080;

// 欄位 ID 對應
const FIELD_IDS = {
  cadastral: 1006096,    // 地籍圖
  license: 1000602,      // 使用執照
  zoning: 1000644,       // 土地使用分區
  nuisance: 1002193      // 嫌惡設施
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ragic Cadastral Query Webhook' });
});

// Main webhook endpoint
app.post('/api/query-cadastral', async (req, res) => {
  try {
    const { county, district, address, recordId } = req.body;

    console.log(`[${new Date().toISOString()}] 收到查詢請求: county=${county}, district=${district}, address=${address}, recordId=${recordId}`);

    if (!county || !district || !address) {
      return res.status(400).json({
        success: false,
        error: '缺少必要的查詢參數：county, district, address'
      });
    }

    if (!recordId) {
      return res.status(400).json({
        success: false,
        error: '缺少記錄 ID：recordId'
      });
    }

    const fullAddress = `${county}${district}${address}`;
    console.log(`完整地址: ${fullAddress}`);

    // 立即回應，讓 Ragic 不會超時
    res.json({
      success: true,
      message: '查詢已開始，正在背景處理中...',
      recordId: recordId
    });

    // 在背景執行查詢和上傳
    processQueries(fullAddress, recordId).catch(err => {
      console.error('背景處理失敗:', err);
    });

  } catch (error) {
    console.error('錯誤:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

async function processQueries(fullAddress, recordId) {
  let browser;
  const tmpDir = `/tmp/ragic_${recordId}_${Date.now()}`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const queries = [
      {
        name: '地籍圖',
        fieldId: FIELD_IDS.cadastral,
        getUrl: (addr) => `https://easymap.land.moi.gov.tw/index?addr=${encodeURIComponent(addr)}`,
        waitTime: 6000
      },
      {
        name: '使用執照',
        fieldId: FIELD_IDS.license,
        getUrl: (addr) => `https://www.cpami.gov.tw/service/online-service/building-permit.html?address=${encodeURIComponent(addr)}`,
        waitTime: 4000
      },
      {
        name: '土地使用分區',
        fieldId: FIELD_IDS.zoning,
        getUrl: (addr) => `https://www.tpzoning.gov.taipei/web/query/index.aspx?address=${encodeURIComponent(addr)}`,
        waitTime: 4000
      },
      {
        name: '嫌惡設施',
        fieldId: FIELD_IDS.nuisance,
        getUrl: (addr) => `https://www.map.com.tw/search?q=${encodeURIComponent(addr)}`,
        waitTime: 5000
      }
    ];

    const results = [];

    for (const query of queries) {
      try {
        console.log(`正在查詢 ${query.name}...`);
        const pdfPath = await capturePageAsPDF(browser, query.getUrl(fullAddress), query.name, tmpDir, query.waitTime);

        if (pdfPath) {
          const uploaded = await uploadFileToRagic(pdfPath, recordId, query.fieldId, query.name);
          results.push({ name: query.name, success: uploaded });
          console.log(`${query.name} 完成，上傳${uploaded ? '成功' : '失敗'}`);
        }
      } catch (err) {
        console.error(`${query.name} 失敗:`, err.message);
        results.push({ name: query.name, success: false, error: err.message });
      }
    }

    console.log('所有查詢完成:', JSON.stringify(results));

  } catch (error) {
    console.error('processQueries 失敗:', error);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

async function capturePageAsPDF(browser, url, name, tmpDir, waitTime) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`打開頁面: ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await new Promise(resolve => setTimeout(resolve, waitTime));

    const pdfPath = path.join(tmpDir, `${name}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });

    console.log(`PDF 已生成: ${pdfPath}`);
    return pdfPath;

  } catch (error) {
    console.error(`頁面截圖失敗 (${name}):`, error.message);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function uploadFileToRagic(filePath, recordId, fieldId, displayName) {
  try {
    const fileName = path.basename(filePath);

    // Step 1: 上傳文件到 Ragic 的文件伺服器
    const fileStream = fs.createReadStream(filePath);
    const formData = new FormData();
    formData.append('file', fileStream, {
      filename: fileName,
      contentType: 'application/pdf'
    });

    const uploadUrl = `${RAGIC_BASE_URL}/sims/uploadFile.jsp?a=${RAGIC_AP}&APIKey=${RAGIC_API_KEY}`;
    console.log(`上傳文件到: ${uploadUrl}`);

    const uploadResponse = await axios.post(uploadUrl, formData, {
      headers: { ...formData.getHeaders() },
      timeout: 30000
    });

    console.log(`文件上傳回應 (${displayName}):`, JSON.stringify(uploadResponse.data));

    let uploadedFileName = null;
    if (uploadResponse.data) {
      if (uploadResponse.data.filename) {
        uploadedFileName = uploadResponse.data.filename;
      } else if (uploadResponse.data.name) {
        uploadedFileName = uploadResponse.data.name;
      } else if (typeof uploadResponse.data === 'string' && uploadResponse.data.trim()) {
        uploadedFileName = uploadResponse.data.trim();
      }
    }

    if (!uploadedFileName) {
      console.error(`無法獲取上傳的文件名 (${displayName}), 回應:`, JSON.stringify(uploadResponse.data));
      return false;
    }

    // Step 2: 將文件名更新到 Ragic 記錄的對應欄位
    const updateData = {};
    updateData[fieldId] = uploadedFileName;

    const updateUrl = `${RAGIC_BASE_URL}/${RAGIC_AP}${FORM_PATH}/${recordId}?APIKey=${RAGIC_API_KEY}&doFormula=true`;
    console.log(`更新欄位 ${fieldId} 到記錄 ${recordId}`);

    const updateResponse = await axios.post(updateUrl, updateData, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });

    console.log(`欄位更新回應 (${displayName}):`, JSON.stringify(updateResponse.data));
    return true;

  } catch (error) {
    console.error(`上傳到 Ragic 失敗 (${displayName}):`, error.message);
    if (error.response) {
      console.error('回應狀態:', error.response.status);
      console.error('回應數據:', JSON.stringify(error.response.data));
    }
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`Ragic 地籍查詢 Webhook 服務已啟動，監聽端口 ${PORT}`);
});

module.exports = app;
