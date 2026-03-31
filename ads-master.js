/**
 * Google Ads Master Script (v15.27 - Removed Placement Stats Sync)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',

    TG_TOKEN:   '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID: 37742949,

    CONVERSION_NAME: 'Offline_Sale',

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT  != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT  : 0,
    EMAIL:                   (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL               ) ? ACCOUNT_CONFIG.EMAIL        : ''
  };

  Logger.log('[CONFIG] SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  // 1. Критическая безопасность
  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e); }
  
  // 2. Настройка новых аккаунтов (отрабатывает быстро)
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e); }

  // 3. Быстрые синхронизации из БД в Google Ads
  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e); }
  
  // 4. Важные выгрузки статистики из Google Ads в БД
  try { updateAccountRegistry_(acc, CONFIG); }     catch (e) { Logger.log('[ERR][REGISTRY] ' + e); }
  try { syncAdsToRegistry_(myId, CONFIG); }        catch (e) { Logger.log('[ERR][SYNC_ADS] ' + e); }

  // 5. Создание объявлений
  try { createAdFromRegistry_(myId, CONFIG); }     catch (e) {
    Logger.log('[ERR][CREATE_AD] ' + e);
    tgSend_('❌ <b>Create Ad — ОШИБКА</b>\nАкк: <code>' + myId + '</code>\n' + e, CONFIG);
  }

  // 6. Заливка конверсий
  try { uploadConversionsFromEdge_(myId, CONFIG); } catch (e) { Logger.log('[ERR][CONVERSIONS] ' + e); }

  // 7. Работа с исключениями площадок (Самая тяжелая задача вынесена в самый конец)
  try { syncPlacementBlacklist_(myId, CONFIG); }    catch (e) { Logger.log('[ERR][BLACKLIST] ' + e); }

  logDivider_('END');

  /* ====================== АВТОСОЗДАНИЕ ГРУППЫ ====================== */

  function maybeCreateDefaultAdGroup_() {
    var agCheck = AdsApp.adGroups().withCondition("Status != REMOVED").get();
    if (agCheck.hasNext()) return;

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

    var EXCLUDE_AGE_RANGES = [ 'AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_UNDETERMINED' ];

    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var campaignIterator = AdsApp.campaigns().withCondition('Name = "' + CAMPAIGN_NAME + '"').get();

    if (!campaignIterator.hasNext()) {
      Logger.log('[SETUP] ❌ Кампания "' + CAMPAIGN_NAME + '" не найдена. Пропуск.');
      return;
    }

    var campaign = campaignIterator.next();
    var adGroupResult = campaign.newAdGroupBuilder().withName(AD_GROUP_NAME).withCpc(CPC_BID).build();

    if (!adGroupResult.isSuccessful()) {
      Logger.log('[SETUP] ❌ Ошибка создания группы: ' + adGroupResult.getErrors());
      return;
    }

    var adGroup = adGroupResult.getResult();
    Logger.log('[SETUP] ✅ Группа создана: ' + AD_GROUP_NAME);

    var topicsAdded = 0;
    for (var i = 0; i < TOPICS.length; i++) {
      var topicId = parseInt(TOPICS[i].resourceName.split('/')[1], 10); 
      var topicResult = adGroup.display().newTopicBuilder().withTopicId(topicId).build();
      if (topicResult.isSuccessful()) topicsAdded++;
    }
    Logger.log('[SETUP] Тем добавлено: ' + topicsAdded + '/' + TOPICS.length);

    var ageOk = 0;
    var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + adGroup.getId();
    for (var a = 0; a < EXCLUDE_AGE_RANGES.length; a++) {
      try {
        AdsApp.mutate({
          adGroupCriterionOperation: {
            create: { adGroup: adGroupResourceName, status: 'ENABLED', negative: true, ageRange: { type: EXCLUDE_AGE_RANGES[a] } }
          }
        });
        ageOk++;
      } catch(e) {}
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

    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var campCount = 0;
    while (campaigns.hasNext()) {
      try { campaigns.next().addExcludedPlacementList(excludedList); campCount++; } catch (e) {}
    }
    Logger.log('[BLACKLIST] Список применен к ' + campCount + ' активным КМС кампаниям.');

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

    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    var getRes = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks', { method: 'get', headers: headers, muteHttpExceptions: true });
    
    if (getRes.getResponseCode() !== 200) return;
    var data = JSON.parse(getRes.getContentText());
    if (!data.conversions || data.count === 0 || data.conversions.length === 0) {
      Logger.log('[CONVERSIONS] Нет конверсий для загрузки');
      return;
    }

    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();

    var uploadedIds = [];
    var cleanId = myId.replace(/-/g, '');

    data.conversions.forEach(function(c) {
      if ((c.account_uid || '').replace(/-/g, '') !== cleanId || !c.gclid) return;
      upload.append({
        'Google Click ID': c.gclid, 'Conversion Name': CONFIG.CONVERSION_NAME,
        'Conversion Time': c.external_timestamp.replace('T', ' ') + '+0100',
        'Conversion Value': c.payout || 0, 'Conversion Currency': c.currency || 'USD'
      });
      uploadedIds.push(c.id);
    });

    if (uploadedIds.length > 0) {
      upload.apply();
      Logger.log('[CONVERSIONS] Отправлено: ' + uploadedIds.length);
      UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks', { method: 'post', headers: headers, payload: JSON.stringify({ ids: uploadedIds }), muteHttpExceptions: true });
      tgSend_('✅ <b>Заливка конверсий</b>\nАкк: <code>' + myId + '</code>\nОтправлено: ' + uploadedIds.length, CONFIG);
    }
  }

  /* ====================== CREATE AD ====================== */

  function createAdFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var tasks = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5', null, null, CONFIG);

    if (!tasks || tasks.length === 0) {
      Logger.log('[CREATE_AD] Нет заданий на создание.');
      return;
    }

    var createdCount = 0;
    var lines = [];

    tasks.forEach(function(task) {
      try {
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
        if (!agIterator.hasNext()) return;

        var adGroup = agIterator.next();
        var sqBlob = UrlFetchApp.fetch(task.square_image_url || task.img_square || 'https://example.com/1x1.jpg').getBlob();
        var sqAsset = AdsApp.adAssets().newImageAssetBuilder().withData(sqBlob).withName('Sq_' + (task.ad_id || 'new').substring(0, 15)).build().getResult();

        var rBlob = UrlFetchApp.fetch(task.rectangle_image_url || task.img_rect || 'https://example.com/1.91x1.jpg').getBlob();
        var rAsset = AdsApp.adAssets().newImageAssetBuilder().withData(rBlob).withName('Rect_' + (task.ad_id || 'new').substring(0, 15)).build().getResult();

        adGroup.newAd().responsiveDisplayAdBuilder()
          .withBusinessName(task.business_name || 'My Business')
          .withFinalUrl(task.final_url || 'https://example.com')
          .addHeadline(task.headline || 'Заголовок')
          .withLongHeadline(task.long_headline || 'Длинный заголовок объявления')
          .addDescription(task.description || 'Описание')
          .addSquareMarketingImage(sqAsset)
          .addMarketingImage(rAsset)
          .build();

        lines.push('📌 Создано: <b>' + (task.headline || 'Заголовок') + '</b>');
        patchSupabase_(CONFIG.TABLE_ADS, { needs_create: false }, 'ad_id=eq.' + task.ad_id, CONFIG);
        createdCount++;
      } catch(e) { lines.push('⚠️ Ошибка: ' + e.message); }
    });

    if (lines.length > 0) tgSend_('✅ <b>Create Ads</b>\nАкк: <code>' + myId + '</code>\nУспешно создано: ' + createdCount + '\n\n' + lines.join('\n'), CONFIG);
  }

  /* ====================== РЕЕСТРЫ И СИНХРОНИЗАЦИЯ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    var cleanId = acc.getCustomerId().replace(/-/g, '');
    Logger.log('[REGISTRY] Сохранение статистики аккаунта. Текущий ID для БД: ' + cleanId);
    
    var activeBid = 0; var balance = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    var payload = {
      uid: cleanId, name: acc.getName(), email: CONFIG.EMAIL,
      today_cost: acc.getStatsFor('TODAY').getCost(), all_cost: acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid, balance: balance, updated_at: new Date().toISOString()
    };
    
    var res = apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
    Logger.log('[REGISTRY] Данные отправлены.');
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[SYNC_ADS] Синхронизация статусов объявлений...');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];

    while (ads.hasNext()) {
      var ad = ads.next();
      var stats = ad.getStatsFor('TODAY');
      var headlines = (typeof ad.getName === 'function') ? ad.getName() : 'Ad #' + ad.getId();
      var policyStatus = 'UNKNOWN';

      try { policyStatus = ad.getPolicyApprovalStatus(); } catch(e) {}

      batch.push({
        ad_id: ad.getId().toString(), account_id: cleanId, campaign_name: ad.getCampaign().getName(),
        type: ad.getType(), headline: headlines.split(' | ')[0],
        final_url: ad.urls().getFinalUrl() || '', clicks: stats.getClicks(), cost: stats.getCost(),
        status: ad.isPaused() ? 'PAUSED' : 'ENABLED', policy_status: policyStatus, updated_at: new Date().toISOString()
      });

      if (batch.length >= 50) { 
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); 
        batch = []; 
      }
    }
    if (batch.length > 0) apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
    Logger.log('[SYNC_ADS] Готово.');
  }

  function syncBidsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[BIDS] Проверка новых ставок в БД (uid: ' + cleanId + ')');
    
    var data = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=target_cpc,needs_bid_sync', null, null, CONFIG);
    
    if (!data || data.length === 0) {
      Logger.log('[BIDS] Аккаунт не найден в БД.');
      return;
    }
    if (!data[0].needs_bid_sync) {
      Logger.log('[BIDS] Изменение ставки не требуется.');
      return;
    }

    var target = data[0].target_cpc;
    Logger.log('[BIDS] Применяем ставку: ' + target);
    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (ags.hasNext()) ags.next().bidding().setCpc(target);
    
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_bid_sync: false }, 'uid=eq.' + cleanId, CONFIG);
  }

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[AD_EDITS] Проверка изменений статусов/ссылок...');
    var edits = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_sync=eq.true', null, null, CONFIG);
    
    if (!edits || edits.length === 0) {
      Logger.log('[AD_EDITS] Нет заданий.');
      return;
    }

    Logger.log('[AD_EDITS] Найдено заданий: ' + edits.length);
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

  /* ====================== API CORE ====================== */

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var headers = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (headersExtra) { for (var h in headersExtra) headers[h] = headersExtra[h]; }

    var res = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
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

  function tgSend_(txt, CONFIG) {
    try { UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TG_TOKEN + '/sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: txt, parse_mode: 'HTML' }), muteHttpExceptions: true }); } catch(e) {}
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
