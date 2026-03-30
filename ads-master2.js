/**
 * Google Ads Master Script (v15.24 - Auto AdGroup Setup + Bulk Exclusions)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',
    TABLE_PLACEMENTS: 'placement_stats',

    TG_TOKEN:   '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID: 37742949,

    CONVERSION_NAME: 'Offline_Sale',

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT             != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT             : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT              != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT              : 0,
    PLACEMENT_SYNC_HOUR_UTC: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC != null) ? ACCOUNT_CONFIG.PLACEMENT_SYNC_HOUR_UTC : 10,
    EMAIL:                   (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL                           ) ? ACCOUNT_CONFIG.EMAIL                    : ''
  };

  Logger.log('[CONFIG] SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e); }
  
  // 1. Автоматическая настройка дефолтной группы (если групп еще нет)
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e); }
  
  try { createAdFromRegistry_(myId, CONFIG); }     catch (e) {
    Logger.log('[ERR][CREATE_AD] ' + e);
    tgSend_('❌ <b>Create Ad — ОШИБКА</b>\nАкк: <code>' + myId + '</code>\n' + e, CONFIG);
  }

  try { uploadConversionsFromEdge_(myId, CONFIG); } catch (e) {
    Logger.log('[ERR][CONVERSIONS] ' + e);
  }

  try { syncPlacementBlacklist_(myId, CONFIG); } catch (e) {
    Logger.log('[ERR][BLACKLIST] ' + e);
  }

  updateAccountRegistry_(acc, CONFIG);
  syncAdsToRegistry_(myId, CONFIG);

  try { maybeSyncPlacementStats_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][PLACEMENTS] ' + e); }

  logDivider_('END');

  /* ====================== АВТОСОЗДАНИЕ ГРУППЫ ====================== */

  function maybeCreateDefaultAdGroup_() {
    var agCheck = AdsApp.adGroups().withCondition("Status != REMOVED").get();
    if (agCheck.hasNext()) {
      return; // Группы уже есть, пропускаем
    }

    Logger.log('[SETUP] В аккаунте нет групп объявлений. Выполняем авто-настройку...');

    var CAMPAIGN_NAME = 'Display-1';
    var CPC_BID = 0.02;
    var AD_GROUP_NAME = 'Topic_All';

    var TOPICS = [
      { name: 'Finance',                   resourceName: 'topicConstants/7'    },
      { name: 'Home-and-Garden',           resourceName: 'topicConstants/11'   },
      { name: 'Travel-and-Transportation', resourceName: 'topicConstants/67'   },
      { name: 'World-Localities',          resourceName: 'topicConstants/5000' },
      { name: 'News',                      resourceName: 'topicConstants/16'   },
      { name: 'Business-and-Industrial',   resourceName: 'topicConstants/12'   },
      { name: 'Law-and-Government',        resourceName: 'topicConstants/19'   }
    ];

    var EXCLUDE_AGE_RANGES = [
      'AGE_RANGE_18_24',
      'AGE_RANGE_25_34',
      'AGE_RANGE_35_44',
      'AGE_RANGE_45_54',
      'AGE_RANGE_UNDETERMINED'
    ];

    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var campaignIterator = AdsApp.campaigns().withCondition('Name = "' + CAMPAIGN_NAME + '"').get();

    if (!campaignIterator.hasNext()) {
      Logger.log('[SETUP] ❌ Кампания "' + CAMPAIGN_NAME + '" не найдена. Пропуск.');
      return;
    }

    var campaign = campaignIterator.next();
    var adGroupResult = campaign.newAdGroupBuilder()
      .withName(AD_GROUP_NAME)
      .withCpc(CPC_BID)
      .build();

    if (!adGroupResult.isSuccessful()) {
      Logger.log('[SETUP] ❌ Ошибка создания группы: ' + adGroupResult.getErrors());
      return;
    }

    var adGroup = adGroupResult.getResult();
    Logger.log('[SETUP] ✅ Группа создана: ' + AD_GROUP_NAME);

    var topicsAdded = 0;
    for (var i = 0; i < TOPICS.length; i++) {
      var topic = TOPICS[i];
      // Извлекаем ID темы из resourceName для безопасного стандартного метода API
      var topicId = parseInt(topic.resourceName.split('/')[1], 10); 
      var topicResult = adGroup.display().newTopicBuilder().withTopicId(topicId).build();

      if (topicResult.isSuccessful()) {
        Logger.log('[SETUP]   📌 Тема добавлена: ' + topic.name);
        topicsAdded++;
      } else {
        Logger.log('[SETUP]   ❌ Тема не добавлена: ' + topic.name + ' — ' + topicResult.getErrors());
      }
    }
    Logger.log('[SETUP] Тем добавлено: ' + topicsAdded + '/' + TOPICS.length);

    var ageOk = 0;
    var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + adGroup.getId();
    for (var a = 0; a < EXCLUDE_AGE_RANGES.length; a++) {
      try {
        AdsApp.mutate({
          adGroupCriterionOperation: {
            create: {
              adGroup: adGroupResourceName,
              status: 'ENABLED',
              negative: true,
              ageRange: { type: EXCLUDE_AGE_RANGES[a] }
            }
          }
        });
        ageOk++;
      } catch(e) {
        Logger.log('[SETUP]   ⚠️ Возраст ' + EXCLUDE_AGE_RANGES[a] + ': ' + e);
      }
    }
    Logger.log('[SETUP] 👤 Исключено возрастов: ' + ageOk + '/' + EXCLUDE_AGE_RANGES.length);
  }

  /* ====================== GLOBAL BLACKLIST ====================== */

  function syncPlacementBlacklist_(myId, CONFIG) {
    Logger.log('[BLACKLIST] Получение глобального списка минус-площадок...');
    var endpoint = '/rest/v1/placement_blacklist?select=placement&limit=10000';
    var data = apiCall_('get', endpoint, null, null, CONFIG);

    if (!data || data.length === 0) {
      Logger.log('[BLACKLIST] Блэклист пуст или недоступен.');
      return;
    }

    var listName = 'Global Supabase Blacklist';
    var listIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + listName + "'").get();
    var excludedList;

    if (listIterator.hasNext()) {
      excludedList = listIterator.next();
    } else {
      excludedList = AdsApp.newExcludedPlacementListBuilder().withName(listName).build().getResult();
      Logger.log('[BLACKLIST] Создан новый список исключений: ' + listName);
    }

    var campaigns = AdsApp.campaigns()
      .withCondition('Status = ENABLED')
      .withCondition('CampaignType = DISPLAY')
      .get();

    var campCount = 0;
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      try {
        camp.addExcludedPlacementList(excludedList);
        campCount++;
      } catch (e) {}
    }
    Logger.log('[BLACKLIST] Список применен к ' + campCount + ' активным КМС кампаниям.');

    Logger.log('[BLACKLIST] Подготовка Bulk Upload (формат CSV)...');
    var columns = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    
    var addedCount = 0;
    data.forEach(function(item) {
      if (item.placement) {
        upload.append({
          'Row Type': 'Negative Placement',
          'Action': 'Add',
          'Customer ID': '',
          'Placement Exclusion List ID': '',
          'Placement Exclusion List Name': listName,
          'Placement Exclusion': item.placement
        });
        addedCount++;
      }
    });

    if (addedCount > 0) {
      upload.apply();
      Logger.log('[BLACKLIST] Bulk Upload запущен. Площадок отправлено: ' + addedCount);
    }
  }

  /* ====================== OFFLINE CONVERSIONS ====================== */

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;

    var url = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks';
    var headers = {
      'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''),
      'Content-Type':  'application/json'
    };

    var getRes = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });
    if (getRes.getResponseCode() !== 200) return;

    var data = JSON.parse(getRes.getContentText());
    if (!data.conversions || data.count === 0 || data.conversions.length === 0) {
      Logger.log('[CONVERSIONS] Нет конверсий для загрузки');
      return;
    }

    var columns = ['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    upload.forOfflineConversions();

    var uploadedIds = [];
    var cleanId = myId.replace(/-/g, '');

    data.conversions.forEach(function(c) {
      var cUid = (c.account_uid || '').replace(/-/g, '');
      if (cUid !== cleanId) return;
      if (!c.gclid) return;

      var formattedTime = c.external_timestamp.replace('T', ' ') + '+0100';
      upload.append({
        'Google Click ID': c.gclid,
        'Conversion Name': CONFIG.CONVERSION_NAME,
        'Conversion Time': formattedTime,
        'Conversion Value': c.payout || 0,
        'Conversion Currency': c.currency || 'USD'
      });
      uploadedIds.push(c.id);
    });

    if (uploadedIds.length > 0) {
      upload.apply();
      Logger.log('[CONVERSIONS] Отправлено: ' + uploadedIds.length);
      UrlFetchApp.fetch(url, { method: 'post', headers: headers, payload: JSON.stringify({ ids: uploadedIds }), muteHttpExceptions: true });
      tgSend_('✅ <b>Заливка конверсий</b>\nАкк: <code>' + myId + '</code>\nУспешно отправлено: ' + uploadedIds.length, CONFIG);
    }
  }

  /* ====================== CREATE AD ====================== */

  function createAdFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[CREATE_AD] Аккаунт Google Ads: ' + cleanId);
    
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5';
    var tasks = apiCall_('get', endpoint, null, null, CONFIG);

    if (!tasks || tasks.length === 0) {
      Logger.log('[CREATE_AD] Нет заданий на создание.');
      return;
    }

    var createdCount = 0;
    var lines = [];

    tasks.forEach(function(task) {
      Logger.log('[CREATE_AD] Обработка задания ID: ' + task.ad_id);
      try {
        var agIterator = AdsApp.adGroups()
          .withCondition('Status = ENABLED')
          .withCondition('CampaignType = DISPLAY')
          .get();

        if (!agIterator.hasNext()) {
          Logger.log('[CREATE_AD] В аккаунте нет активных групп объявлений КМС');
          return;
        }

        var adGroup = agIterator.next();
        Logger.log('[CREATE_AD] Целевая группа: ' + adGroup.getName());

        var sqImg = task.square_image_url || task.img_square || 'https://example.com/1x1.jpg';
        var rImg = task.rectangle_image_url || task.img_rect || 'https://example.com/1.91x1.jpg';

        var squareBlob  = UrlFetchApp.fetch(sqImg).getBlob();
        var squareAsset = AdsApp.adAssets().newImageAssetBuilder()
          .withData(squareBlob)
          .withName('Sq_' + (task.ad_id || 'new').substring(0, 15))
          .build()
          .getResult();

        var rectBlob  = UrlFetchApp.fetch(rImg).getBlob();
        var rectAsset = AdsApp.adAssets().newImageAssetBuilder()
          .withData(rectBlob)
          .withName('Rect_' + (task.ad_id || 'new').substring(0, 15))
          .build()
          .getResult();

        var bName = task.business_name || 'My Business';
        var fUrl  = task.final_url || 'https://example.com';
        var head  = task.headline || 'Заголовок';
        var lHead = task.long_headline || 'Длинный заголовок объявления';
        var desc  = task.description || 'Описание';

        adGroup.newAd().responsiveDisplayAdBuilder()
          .withBusinessName(bName)
          .withFinalUrl(fUrl)
          .addHeadline(head)
          .withLongHeadline(lHead)
          .addDescription(desc)
          .addSquareMarketingImage(squareAsset)
          .addMarketingImage(rectAsset)
          .build();

        Logger.log('[CREATE_AD] Отправлена команда на создание');
        lines.push('📌 Создано в: <b>' + adGroup.getName() + '</b> (Заг: ' + head + ')');

        patchSupabase_(CONFIG.TABLE_ADS, { needs_create: false }, 'ad_id=eq.' + task.ad_id, CONFIG);
        createdCount++;

      } catch(e) {
        Logger.log('[CREATE_AD] Ошибка в цикле: ' + e);
        lines.push('⚠️ Ошибка: ' + e.message);
      }
    });

    if (lines.length > 0) {
      tgSend_('✅ <b>Create Ads</b>\nАкк: <code>' + myId + '</code>\nУспешно создано: ' + createdCount + '\n\n' + lines.join('\n'), CONFIG);
    }
  }

  /* ====================== PLACEMENT ====================== */

  function maybeSyncPlacementStats_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var currentHourUTC = new Date().getUTCHours();
    var yesterday      = getYesterdayDate_();

    if (currentHourUTC !== CONFIG.PLACEMENT_SYNC_HOUR_UTC) { return; }

    var check = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS + '?account_id=eq.' + cleanId + '&date=eq.' + yesterday + '&limit=1', null, null, CONFIG);
    if (check && check.length > 0) { return; }

    syncPlacementStats_(myId, CONFIG);
  }

  function syncPlacementStats_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var yesterday = getYesterdayDate_();
    var gaql = 'SELECT detail_placement_view.display_name, detail_placement_view.placement, detail_placement_view.placement_type, campaign.name, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM detail_placement_view WHERE segments.date = \'' + yesterday + '\' AND metrics.impressions > 0';

    var rows  = AdsApp.search(gaql);
    var batch = [];
    var total = 0;

    while (rows.hasNext()) {
      var row = rows.next();
      batch.push({
        account_id:     cleanId,
        placement:      (row.detailPlacementView || {}).placement || '',
        display_name:   (row.detailPlacementView || {}).displayName || ((row.detailPlacementView || {}).placement || ''),
        placement_type: (row.detailPlacementView || {}).placementType || '',
        campaign_name:  (row.campaign && row.campaign.name) || '',
        ad_group_name:  (row.adGroup  && row.adGroup.name)  || '',
        date:           yesterday,
        impressions:    parseInt((row.metrics && row.metrics.impressions) || 0, 10),
        clicks:         parseInt((row.metrics && row.metrics.clicks)      || 0, 10),
        cost:           parseInt((row.metrics && row.metrics.costMicros)  || 0, 10) / 1000000,
        conversions:    parseFloat((row.metrics && row.metrics.conversions) || 0),
        updated_at:     new Date().toISOString()
      });
      total++;
      if (batch.length >= 50) { apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); batch = []; }
    }
    if (batch.length > 0) { apiCall_('post', '/rest/v1/' + CONFIG.TABLE_PLACEMENTS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); }
  }

  /* ====================== УПРАВЛЕНИЕ СТАТУСАМИ И URL ====================== */

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var edits = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_sync=eq.true', null, null, CONFIG);
    if (!edits || edits.length === 0) return;

    edits.forEach(function(edit) {
      var adIterator = AdsApp.ads().withIds([edit.ad_id]).get();
      if (!adIterator.hasNext()) return;
      var ad = adIterator.next();

      if (edit.target_status === 'ENABLED') ad.enable();
      if (edit.target_status === 'PAUSED')  ad.pause();
      if (edit.edit_final_url) ad.urls().setFinalUrl(edit.edit_final_url);

      patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false, edit_final_url: null, target_status: null }, 'ad_id=eq.' + edit.ad_id, CONFIG);
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
    var cleanId = acc.getCustomerId().replace(/-/g, '');
    var activeBid = 0; var balance = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, {
      uid: cleanId, name: acc.getName(), email: CONFIG.EMAIL,
      today_cost: acc.getStatsFor('TODAY').getCost(), all_cost: acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid, balance: balance, updated_at: new Date().toISOString()
    }, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];

    while (ads.hasNext()) {
      var ad = ads.next();
      var stats = ad.getStatsFor('TODAY');
      var adType = ad.getType();
      var headlines = 'Display Ad';
      var descriptions = '';
      var policyStatus = 'UNKNOWN';

      try { policyStatus = ad.getPolicyApprovalStatus(); } catch(e) {}
      try {
        if (adType === 'MULTI_ASSET_RESPONSIVE_DISPLAY_AD') {
          var rda = ad.asType().responsiveDisplayAd();
          headlines = rda.getHeadlines().map(function(h) { return h.getText(); }).join(' | ');
          descriptions = rda.getDescriptions().map(function(d) { return d.getText(); }).join(' | ');
        } else {
          headlines = (typeof ad.getName === 'function') ? ad.getName() : 'Ad #' + ad.getId();
        }
      } catch(e) {}

      batch.push({
        ad_id: ad.getId().toString(), account_id: cleanId, campaign_name: ad.getCampaign().getName(),
        type: adType, headline: headlines.split(' | ')[0], headlines: headlines, descriptions: descriptions,
        final_url: ad.urls().getFinalUrl() || '', clicks: stats.getClicks(), cost: stats.getCost(),
        status: ad.isPaused() ? 'PAUSED' : 'ENABLED', policy_status: policyStatus, updated_at: new Date().toISOString()
      });

      if (batch.length >= 50) { apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); batch = []; }
    }
    if (batch.length > 0) { apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); }
  }

  /* ====================== API CORE ====================== */

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var url = CONFIG.SUPABASE_URL + endpoint;
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var headers = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (headersExtra) { for (var h in headersExtra) { headers[h] = headersExtra[h]; } }

    var res = UrlFetchApp.fetch(url, { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
    
    var code = res.getResponseCode();
    if (code !== 200 && code !== 201 && code !== 204) {
      Logger.log('[API_ERROR] ' + method.toUpperCase() + ' ' + endpoint + ' | Code: ' + code + ' | Body: ' + res.getContentText());
    }

    return (method === 'get' && code === 200) ? JSON.parse(res.getContentText()) : null;
  }

  function patchSupabase_(table, data, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/' + table + '?' + query, {
      method: 'patch', contentType: 'application/json', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
      payload: JSON.stringify(data), muteHttpExceptions: true
    });
  }

  /* ====================== HELPERS ====================== */

  function syncBidsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var data = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=target_cpc,needs_bid_sync', null, null, CONFIG);
    if (data && data.length > 0 && data[0].needs_bid_sync) {
      var target = data[0].target_cpc;
      var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
      while (ags.hasNext()) { ags.next().bidding().setCpc(target); }
      patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_bid_sync: false }, 'uid=eq.' + cleanId, CONFIG);
    }
  }

  function getYesterdayDate_() {
    var d = new Date(); d.setDate(d.getDate() - 1);
    var yyyy = d.getFullYear(); var mm = ('0' + (d.getMonth() + 1)).slice(-2); var dd = ('0' + d.getDate()).slice(-2);
    return yyyy + '-' + mm + '-' + dd;
  }

  function tgSend_(txt, CONFIG) {
    try {
      UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TG_TOKEN + '/sendMessage', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: txt, parse_mode: 'HTML' }), muteHttpExceptions: true
      });
    } catch(e) {}
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
