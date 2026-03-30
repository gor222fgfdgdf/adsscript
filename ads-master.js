/**
 * Google Ads Master Script (v15.9 - directAd + AssetBuilder + newTG)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',
    TABLE_PLACEMENTS: 'placement_stats',

    TG_TOKEN:   '5203374800:AAFkuCpj8bgGyBi53WPWW3-QjHDvR_V1tq8',
    TG_CHAT_ID: 37742949,

    ALLOWED_UID: '546-061-2380',

    BUDGET_BOOST_AMOUNT:     500000, // прибавка к дневному бюджету каждый запуск (единицы валюты аккаунта)

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT             != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT             : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT              != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT              : 0,
    PLACEMENT_SYNC_HOUR_UTC: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC != null) ? ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC : 10,
    EMAIL:                   (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL                           ) ? ACCOUNT_CONFIG.EMAIL                    : ''
  };

  Logger.log('[CONFIG] SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT + ' EMAIL=' + CONFIG.EMAIL);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }  catch (e) { Logger.log('[ERR][SAFETY] ' + e); }
  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e); }
  
  try { boostCampaignBudgets_(myId, CONFIG); }     catch (e) {
    Logger.log('[ERR][BOOST_BUDGET] ' + e);
    tgSend_('❌ <b>Boost Budget — ОШИБКА</b>\nАкк: <code>' + myId + '</code>\n' + e, CONFIG);
  }

  try { createAdDirectly_(myId, CONFIG); }         catch (e) {
    Logger.log('[ERR][CREATE_AD] ' + e);
    tgSend_('❌ <b>Create Ad — ОШИБКА</b>\nАкк: <code>' + myId + '</code>\n' + e, CONFIG);
  }

  updateAccountRegistry_(acc, CONFIG);
  syncAdsToRegistry_(myId, CONFIG);

  try { maybeSyncPlacementStats_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][PLACEMENTS] ' + e); }

  logDivider_('END');

  /* ====================== CREATE AD ====================== */

  function createAdDirectly_(myId, CONFIG) {
    var normalizedCurrent = myId.replace(/-/g, '');
    var normalizedAllowed = CONFIG.ALLOWED_UID ? CONFIG.ALLOWED_UID.replace(/-/g, '') : null;

    if (!normalizedAllowed || normalizedCurrent !== normalizedAllowed) {
      Logger.log('[CREATE_AD] Skip — аккаунт не в списке разрешённых');
      return;
    }

    var lines = [];
    var createdCount = 0;

    try {
      var agIterator = AdsApp.adGroups()
        .withCondition('Status = ENABLED')
        .withCondition('CampaignType = DISPLAY')
        .get();

      if (!agIterator.hasNext()) {
        throw new Error("Нет активных групп объявлений (CampaignType = DISPLAY).");
      }

      var adGroup = agIterator.next();

      // 1. Загрузка и создание Asset для картинок
      var imgRectUrl = 'https://media.mssg.me/w/6981e70a610fc484959b1bd1/websites/698dc8e2f2cd285a7466aaa1/w3_1774767696688.jpeg';
      var imgSquareUrl = 'https://media.mssg.me/w/6981e70a610fc484959b1bd1/websites/698dc8e2f2cd285a7466aaa1/sq3_1774767304470.jpeg';

      var rectAsset, squareAsset;

      try {
        var rectBlob = UrlFetchApp.fetch(imgRectUrl).getBlob();
        rectAsset = AdsApp.adAssets().newImageAssetBuilder().withData(rectBlob).withName('Rect_' + Date.now()).build().getResult();
      } catch(e) { throw new Error("Ошибка загрузки прямоугольной картинки по URL: " + imgRectUrl + ". Подробности: " + e.message); }

      try {
        var squareBlob = UrlFetchApp.fetch(imgSquareUrl).getBlob();
        squareAsset = AdsApp.adAssets().newImageAssetBuilder().withData(squareBlob).withName('Square_' + Date.now()).build().getResult();
      } catch(e) { throw new Error("Ошибка загрузки квадратной картинки по URL: " + imgSquareUrl + ". Подробности: " + e.message); }

      // 2. Сборка объявления с передачей Asset
      var adOperation;
      try {
        adOperation = adGroup.newAd().responsiveDisplayAdBuilder()
          .withBusinessName('My Business')
          .withFinalUrl('https://www.1xbetoff1iccbk-fms.it.com/')
          .addHeadline('Заголовок')
          .withLongHeadline('Длинный заголовок объявления')
          .addDescription('Описание')
          .addMarketingImage(rectAsset)
          .addSquareMarketingImage(squareAsset)
          .build();
      } catch(e) { throw new Error("Сбой в билдере объявления: " + e.message); }

      // 3. Проверка успешности создания
      if (!adOperation.isSuccessful()) {
        throw new Error("Отклонено Google Ads: " + adOperation.getErrors().join(' | '));
      }

      Logger.log('[CREATE_AD] Создано в группе: ' + adGroup.getName());
      lines.push('📌 Создано в: <b>' + adGroup.getName() + '</b> (Заг: Заголовок)');
      createdCount++;

    } catch(e) {
      Logger.log('[CREATE_AD] Ошибка: ' + e);
      var errMsg = '⚠️ <b>Ошибка создания объявления</b>\nПричина: ' + e.message;
      lines.push(errMsg);
      
      // Моментальный алерт в ТГ с деталями проблемы
      tgSend_('❌ <b>CREATE AD DEBUG</b>\nАкк: <code>' + myId + '</code>\n\n' + errMsg, CONFIG);
    }

    if (lines.length > 0 && createdCount > 0) {
      var msg =
        '✅ <b>Create Ads</b>\n' +
        'Акк: <code>' + myId + '</code>\n' +
        'Успешно создано: ' + createdCount + '\n\n' +
        lines.join('\n');
      tgSend_(msg, CONFIG);
    }
  }

  /* ====================== BOOST BUDGET ====================== */

  function boostCampaignBudgets_(myId, CONFIG) {
    var normalizedCurrent = myId.replace(/-/g, '');
    var normalizedAllowed = CONFIG.ALLOWED_UID ? CONFIG.ALLOWED_UID.replace(/-/g, '') : null;

    if (!normalizedAllowed || normalizedCurrent !== normalizedAllowed) {
      Logger.log('[BOOST_BUDGET] Skip — аккаунт не в списке разрешённых');
      return;
    }

    var campaigns = AdsApp.campaigns()
      .withCondition('Status = ENABLED')
      .get();

    if (!campaigns.hasNext()) {
      Logger.log('[BOOST_BUDGET] Нет активных кампаний');
      tgSend_('⚠️ <b>Boost Budget</b>\nАкк: <code>' + myId + '</code>\nАктивных кампаний не найдено.', CONFIG);
      return;
    }

    var lines   = [];
    var boosted = 0;

    while (campaigns.hasNext()) {
      var camp      = campaigns.next();
      var budget    = camp.getBudget();
      var current   = budget.getAmount();
      var newAmount = current + CONFIG.BUDGET_BOOST_AMOUNT;

      budget.setAmount(newAmount);

      Logger.log('[BOOST_BUDGET] ' + camp.getName() +
        ' | было: ' + current +
        ' | стало: ' + newAmount);

      lines.push('📌 <b>' + camp.getName() + '</b>\n' +
        '   ' + current + ' → ' + newAmount);

      boosted++;
    }

    var now     = new Date();
    var timeStr = ('0' + now.getUTCHours()).slice(-2) + ':' +
                  ('0' + now.getUTCMinutes()).slice(-2) + ' UTC';

    var msg =
      '✅ <b>Boost Budget</b>\n' +
      'Акк: <code>' + myId + '</code>\n' +
      'Время: ' + timeStr + '\n' +
      'Кампаний обновлено: ' + boosted + '\n\n' +
      lines.join('\n\n');

    tgSend_(msg, CONFIG);

    Logger.log('[BOOST_BUDGET] Обновлено кампаний: ' + boosted);
  }

  /* ====================== PLACEMENT ====================== */

  function maybeSyncPlacementStats_(myId, CONFIG) {
    var currentHourUTC = new Date().getUTCHours();
    var yesterday      = getYesterdayDate_();

    if (currentHourUTC !== CONFIG.PLACEMENT_SYNC_HOUR_UTC) {
      Logger.log('[PLACEMENTS] Skip — not sync hour (now=' + currentHourUTC + ' UTC, expected=' + CONFIG.PLACEMENT_SYNC_HOUR_UTC + ')');
      return;
    }

    var check = apiCall_('get',
      '/rest/v1/' + CONFIG.TABLE_PLACEMENTS +
      '?account_id=eq.' + myId +
      '&date=eq.'       + yesterday +
      '&limit=1',
      null, null, CONFIG
    );

    if (check && check.length > 0) {
      Logger.log('[PLACEMENTS] Skip — already synced for ' + yesterday);
      return;
    }

    syncPlacementStats_(myId, CONFIG);
  }

  function syncPlacementStats_(myId, CONFIG) {
    var yesterday = getYesterdayDate_();
    Logger.log('[PLACEMENTS] Fetching for: ' + yesterday);

    var gaql =
      'SELECT ' +
      '  detail_placement_view.display_name, ' +
      '  detail_placement_view.placement, ' +
      '  detail_placement_view.placement_type, ' +
      '  campaign.name, ' +
      '  ad_group.name, ' +
      '  metrics.impressions, ' +
      '  metrics.clicks, ' +
      '  metrics.cost_micros, ' +
      '  metrics.conversions ' +
      'FROM detail_placement_view ' +
      'WHERE segments.date = \'' + yesterday + '\' ' +
      'AND metrics.impressions > 0';

    var rows  = AdsApp.search(gaql);
    var batch = [];
    var total = 0;

    while (rows.hasNext()) {
      var row           = rows.next();
      var dpv           = row.detailPlacementView || {};
      var placement     = dpv.placement      || '';
      var displayName   = dpv.displayName    || placement;
      var placementType = dpv.placementType  || '';
      var campaignName  = (row.campaign && row.campaign.name) || '';
      var adGroupName   = (row.adGroup  && row.adGroup.name)  || '';
      var impressions   = parseInt((row.metrics && row.metrics.impressions) || 0, 10);
      var clicks        = parseInt((row.metrics && row.metrics.clicks)      || 0, 10);
      var costMicros    = parseInt((row.metrics && row.metrics.costMicros)  || 0, 10);
      var conversions   = parseFloat((row.metrics && row.metrics.conversions) || 0);

      batch.push({
        account_id:     myId,
        placement:      placement,
        display_name:   displayName,
        placement_type: placementType,
        campaign_name:  campaignName,
        ad_group_name:  adGroupName,
        date:           yesterday,
        impressions:    impressions,
        clicks:         clicks,
        cost:           costMicros / 1000000,
        conversions:    conversions,
        updated_at:     new Date().toISOString()
      });

      total++;

      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        batch = [];
        Logger.log('[PLACEMENTS] Batch sent: 50 rows');
      }
    }

    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
      Logger.log('[PLACEMENTS] Batch sent: ' + batch.length + ' rows');
    }

    Logger.log('[PLACEMENTS] Done. Total synced: ' + total);
  }

  /* ====================== УПРАВЛЕНИЕ СТАТУСАМИ И URL ====================== */

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var edits = apiCall_('get',
      '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + myId + '&needs_sync=eq.true',
      null, null, CONFIG
    );

    if (!edits || edits.length === 0) return;
    Logger.log('[SYNC] Правок найдено: ' + edits.length);

    edits.forEach(function(edit) {
      var adIterator = AdsApp.ads().withIds([edit.ad_id]).get();
      if (!adIterator.hasNext()) return;

      var ad = adIterator.next();

      if (edit.target_status === 'ENABLED') { ad.enable(); Logger.log('[STATUS] Ad ' + edit.ad_id + ' -> ENABLED'); }
      if (edit.target_status === 'PAUSED')  { ad.pause();  Logger.log('[STATUS] Ad ' + edit.ad_id + ' -> PAUSED'); }

      if (edit.edit_final_url) {
        ad.urls().setFinalUrl(edit.edit_final_url);
        Logger.log('[URL] Ad ' + edit.ad_id + ' -> ' + edit.edit_final_url);
      }

      patchSupabase_(CONFIG.TABLE_ADS, {
        needs_sync:     false,
        edit_final_url: null,
        target_status:  null
      }, 'ad_id=eq.' + edit.ad_id, CONFIG);
    });
  }

  /* ====================== СТРОГАЯ БЕЗОПАСНОСТЬ ====================== */

  function checkSafetyLimitsStrict_(acc, CONFIG) {
    var todayCost  = acc.getStatsFor('TODAY').getCost();
    var totalLimit = CONFIG.SAFETY_LIMIT + CONFIG.EXTRA_LIMIT;
    var balance    = 0;

    try {
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    if (todayCost >= totalLimit || balance <= -totalLimit) {
      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (campaigns.hasNext()) {
        var camp = campaigns.next();
        var ads  = camp.ads().get();
        while (ads.hasNext()) { ads.next().remove(); }
        camp.pause();
      }
      tgSend_('🛑 <b>CRITICAL STOP</b>\nAcc: ' + acc.getCustomerId() + '\nAds DELETED (' + totalLimit + '$).', CONFIG);
    }
  }

  /* ====================== РЕЕСТРЫ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    var activeBid = 0;
    var balance   = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, {
      uid:         acc.getCustomerId(),
      name:        acc.getName(),
      email:       CONFIG.EMAIL,
      today_cost:  acc.getStatsFor('TODAY').getCost(),
      all_cost:    acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid,
      balance:     balance,
      updated_at:  new Date().toISOString()
    }, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    var ads = AdsApp.ads()
      .withCondition('CampaignType = DISPLAY')
      .withCondition('Status IN [ENABLED, PAUSED]')
      .get();

    var batch = [];

    while (ads.hasNext()) {
      var ad           = ads.next();
      var stats        = ad.getStatsFor('TODAY');
      var adType       = ad.getType();
      var headlines    = 'Display Ad';
      var descriptions = '';

      try {
        if (adType === 'MULTI_ASSET_RESPONSIVE_DISPLAY_AD') {
          var rda      = ad.asType().responsiveDisplayAd();
          headlines    = rda.getHeadlines().map(function(h)    { return h.getText(); }).join(' | ');
          descriptions = rda.getDescriptions().map(function(d) { return d.getText(); }).join(' | ');
        } else {
          headlines = (typeof ad.getName === 'function') ? ad.getName() : 'Ad #' + ad.getId();
        }
      } catch(e) {}

      batch.push({
        ad_id:         ad.getId().toString(),
        account_id:    myId,
        campaign_name: ad.getCampaign().getName(),
        type:          adType,
        headline:      headlines.split(' | ')[0],
        headlines:     headlines,
        descriptions:  descriptions,
        final_url:     ad.urls().getFinalUrl() || '',
        clicks:        stats.getClicks(),
        cost:          stats.getCost(),
        status:        ad.isPaused() ? 'PAUSED' : 'ENABLED',
        updated_at:    new Date().toISOString()
      });

      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        batch = [];
      }
    }

    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
    }
  }

  /* ====================== API CORE ====================== */

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var url     = CONFIG.SUPABASE_URL + endpoint;
    var key     = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var headers = {
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json'
    };
    if (headersExtra) { for (var h in headersExtra) { headers[h] = headersExtra[h]; } }

    var res = UrlFetchApp.fetch(url, {
      method:             method,
      headers:            headers,
      payload:            payload ? JSON.stringify(payload) : null,
      muteHttpExceptions: true
    });

    return (method === 'get' && res.getResponseCode() === 200)
      ? JSON.parse(res.getContentText())
      : null;
  }

  function patchSupabase_(table, data, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
      method:             'patch',
      contentType:        'application/json',
      headers:            { 'apikey': key, 'Authorization': 'Bearer ' + key },
      payload:            JSON.stringify(data),
      muteHttpExceptions: true
    });
  }

  /* ====================== HELPERS ====================== */

  function syncBidsFromRegistry_(myId, CONFIG) {
    var data = apiCall_('get',
      '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + myId + '&select=target_cpc,needs_bid_sync',
      null, null, CONFIG
    );
    if (data && data.length > 0 && data[0].needs_bid_sync) {
      var target = data[0].target_cpc;
      var ags    = AdsApp.adGroups().withCondition('Status = ENABLED').get();
      while (ags.hasNext()) { ags.next().bidding().setCpc(target); }
      apiCall_('patch', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + myId, { needs_bid_sync: false }, null, CONFIG);
    }
  }

  function getYesterdayDate_() {
    var d    = new Date();
    d.setDate(d.getDate() - 1);
    var yyyy = d.getFullYear();
    var mm   = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd   = ('0' + d.getDate()).slice(-2);
    return yyyy + '-' + mm + '-' + dd;
  }

  function tgSend_(txt, CONFIG) {
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TG_TOKEN + '/sendMessage', {
        method:             'post',
        contentType:        'application/json',
        payload:            JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: txt, parse_mode: 'HTML' }),
        muteHttpExceptions: true
      });
    } catch(e) {}
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
