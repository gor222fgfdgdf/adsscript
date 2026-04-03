/**
 * Google Ads Master Script (v16.2 - Backward Compatible SaaS)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    PROJECT_ID:       (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PROJECT_ID) ? ACCOUNT_CONFIG.PROJECT_ID : null,

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',
    TABLE_BLACKLIST:  'placement_blacklist',
    TABLE_ASSETS:     'asset_performance',

    TG_TOKEN:   '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID: 37742949,

    CONVERSION_NAME: 'Offline_Sale',

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT  != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT  : 0,
    EMAIL:                   (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL               ) ? ACCOUNT_CONFIG.EMAIL        : ''
  };

  Logger.log('[CONFIG] Project ID: ' + (CONFIG.PROJECT_ID || 'DEFAULT (Backward Compat)') + ' | LIMIT: ' + CONFIG.SAFETY_LIMIT + '+' + CONFIG.EXTRA_LIMIT);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e.message); }
  
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e.message); }
  try { ensureNewsTopicInAllGroups_(); }           catch (e) { Logger.log('[ERR][TOPICS] ' + e.message); }
  try { ensureConversionAction_(CONFIG); }         catch (e) { Logger.log('[ERR][CONV_SETUP] ' + e.message); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e.message); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e.message); }
  
  try { updateAccountRegistry_(acc, CONFIG); }     catch (e) { Logger.log('[ERR][REGISTRY] ' + e.message); }
  try { syncAdsToRegistry_(myId, CONFIG); }        catch (e) { Logger.log('[ERR][SYNC_ADS] ' + e.message); }
  try { syncAssetPerformance_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][ASSETS] ' + e.message); }

  try { createAdFromRegistry_(myId, CONFIG); }     catch (e) {
    Logger.log('[ERR][CREATE_AD] ' + e.message);
    tgSend_('❌ <b>Create Ad — ОШИБКА</b>\nАкк: <code>' + myId + '</code>\n' + e.message, CONFIG);
  }

  try { uploadConversionsFromEdge_(myId, CONFIG); } catch (e) { Logger.log('[ERR][CONVERSIONS] ' + e.message); }
  
  try { excludeYoutube_(); }                        catch (e) { Logger.log('[ERR][YOUTUBE] ' + e.message); }
  try { syncPlacementBlacklist_(myId, CONFIG); }    catch (e) { Logger.log('[ERR][BLACKLIST] ' + e.message); }

  logDivider_('END');

  /* ====================== АВТОСОЗДАНИЕ КОНВЕРСИИ ====================== */

  function ensureConversionAction_(CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;
    Logger.log('[SETUP] Проверка наличия оффлайн-конверсии: ' + CONFIG.CONVERSION_NAME);
    
    var query = "SELECT conversion_action.id, conversion_action.name FROM conversion_action WHERE conversion_action.name = '" + CONFIG.CONVERSION_NAME + "'";
    var result = AdsApp.search(query);

    if (result.hasNext()) {
      Logger.log('[SETUP] Конверсия "' + CONFIG.CONVERSION_NAME + '" уже существует.');
      return;
    }

    Logger.log('[SETUP] Конверсия не найдена. Создаем автоматически через API Mutate...');
    try {
      AdsApp.mutate({
        conversionActionOperation: {
          create: { name: CONFIG.CONVERSION_NAME, type: 'UPLOAD_CLICKS', category: 'PURCHASE', status: 'ENABLED' }
        }
      });
      Logger.log('[SETUP] ✅ Оффлайн-конверсия успешно создана!');
    } catch (e) {
      Logger.log('[SETUP] ❌ Ошибка автоматического создания конверсии: ' + e.message);
    }
  }

  /* ====================== АВТОСОЗДАНИЕ ГРУППЫ И ТЕМ ====================== */

  function maybeCreateDefaultAdGroup_() {
    Logger.log('[SETUP] Проверка наличия групп объявлений...');
    var agCheck = AdsApp.adGroups().withCondition("Status != REMOVED").get();
    if (agCheck.hasNext()) return;

    var CAMPAIGN_NAME = 'Display-1';
    var CPC_BID = 0.02;
    var AD_GROUP_NAME = 'Topic_All';
    var EXCLUDE_AGE_RANGES = [ 'AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_UNDETERMINED' ];

    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var campaignIterator = AdsApp.campaigns().withCondition('Name = "' + CAMPAIGN_NAME + '"').get();

    if (!campaignIterator.hasNext()) {
      Logger.log('[SETUP] ❌ Кампания ' + CAMPAIGN_NAME + ' не найдена.'); return;
    }

    var campaign = campaignIterator.next();
    var adGroupResult = campaign.newAdGroupBuilder().withName(AD_GROUP_NAME).withCpc(CPC_BID).build();
    if (!adGroupResult.isSuccessful()) return;

    var adGroup = adGroupResult.getResult();
    var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + adGroup.getId();
    for (var a = 0; a < EXCLUDE_AGE_RANGES.length; a++) {
      try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: adGroupResourceName, status: 'ENABLED', negative: true, ageRange: { type: EXCLUDE_AGE_RANGES[a] } } } }); } catch(e) {}
    }
    Logger.log('[SETUP] ✅ Базовая группа успешно настроена.');
  }

  function ensureNewsTopicInAllGroups_() {
    Logger.log('[TOPICS] Проверка наличия топика News (ID 16)...');
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      try {
        var existingTopics = ag.display().topics().get();
        var found = false;
        while (existingTopics.hasNext()) {
          var t = existingTopics.next();
          if (t.getTopicId() === 16) {
            found = true;
            if (t.isPaused() || !t.isEnabled()) t.enable();
            break;
          }
        }
        if (!found) ag.display().newTopicBuilder().withTopicId(16).build();
      } catch(e) {}
    }
  }

  /* ====================== ИСКЛЮЧЕНИЕ YOUTUBE ====================== */

  function excludeYoutube_() {
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var urlsToExclude = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      urlsToExclude.forEach(function(url) {
        try { camp.display().newPlacementBuilder().withUrl(url).exclude(); } catch (e) {}
      });
    }
  }

  /* ====================== BLACKLIST ====================== */

  function syncPlacementBlacklist_(myId, CONFIG) {
    Logger.log('[BLACKLIST] Проверка статуса синхронизации...');
    var cleanId = myId.replace(/-/g, '');
    var accData = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=blacklist_synced_at', null, null, CONFIG);
    var lastSync = (accData && accData.length > 0) ? accData[0].blacklist_synced_at : null;

    var oldListName = 'Global Supabase Blacklist V3';
    var newListName = 'Global Supabase Blacklist V4';

    var oldListIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + oldListName + "'").get();
    if (oldListIterator.hasNext()) {
      var oldList = oldListIterator.next();
      var linkedCamps = oldList.campaigns().get();
      while (linkedCamps.hasNext()) { try { linkedCamps.next().removeExcludedPlacementList(oldList); } catch(e) {} }
    }

    var excludedList;
    var isNewList = false;
    var listIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + newListName + "'").get();
    
    if (listIterator.hasNext()) {
      excludedList = listIterator.next();
    } else {
      excludedList = AdsApp.newExcludedPlacementListBuilder().withName(newListName).build().getResult();
      Logger.log('[BLACKLIST] Создан НОВЫЙ список исключений: ' + newListName);
      isNewList = true; lastSync = null; 
    }

    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (campaigns.hasNext()) { try { campaigns.next().addExcludedPlacementList(excludedList); } catch (e) {} }

    var endpoint = '/rest/v1/' + CONFIG.TABLE_BLACKLIST + '?select=placement,created_at&limit=10000';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    if (lastSync) endpoint += '&created_at=gt.' + encodeURIComponent(lastSync);

    var data = apiCall_('get', endpoint, null, null, CONFIG);

    var GAME_CATEGORIES = ['mobileappcategory::60008', 'mobileappcategory::60506'];
    var columns = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    var addedCount = 0;
    var maxCreatedAt = lastSync;

    if (isNewList) {
      GAME_CATEGORIES.forEach(function(item) { upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item }); addedCount++; });
    }

    if (data && data.length > 0) {
      data.forEach(function(item) {
        if (item.placement && item.placement.indexOf('youtube.com') === -1 && GAME_CATEGORIES.indexOf(item.placement) === -1) { 
          upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement });
          addedCount++;
          if (!maxCreatedAt || item.created_at > maxCreatedAt) maxCreatedAt = item.created_at;
        }
      });
    }

    if (addedCount > 0) {
      upload.apply();
      Logger.log('[BLACKLIST] Отправлено площадок: ' + addedCount);
      if (maxCreatedAt) patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAt }, 'uid=eq.' + cleanId, CONFIG);
    }
  }

  /* ====================== CONVERSIONS ====================== */

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[CONVERSIONS] Проверка конверсий для аккаунта ' + cleanId);

    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    var fetchUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks?uid=' + cleanId;
    
    var getRes = UrlFetchApp.fetch(fetchUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
    if (getRes.getResponseCode() !== 200) return;
    
    var data = JSON.parse(getRes.getContentText());
    if (!data || !data.conversions || data.conversions.length === 0) return;

    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();
    var uploadedIds = [];

    data.conversions.forEach(function(c) {
      var targetAcc = (c.account_uid || '').replace(/-/g, '');
      if (targetAcc !== cleanId || !c.gclid) return;

      var convTime = c.external_timestamp ? c.external_timestamp.replace('T', ' ') + '+0100' : 'ПУСТО';
      upload.append({
        'Google Click ID': c.gclid, 
        'Conversion Name': CONFIG.CONVERSION_NAME,
        'Conversion Time': convTime, 
        'Conversion Value': c.payout || 0, 
        'Conversion Currency': c.currency || 'USD'
      });
      uploadedIds.push(c.id);
    });

    if (uploadedIds.length > 0) {
      upload.apply();
      Logger.log('[CONVERSIONS] Отправлено: ' + uploadedIds.length);
      UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks', { method: 'post', headers: headers, payload: JSON.stringify({ ids: uploadedIds }), muteHttpExceptions: true });
    }
  }

  /* ====================== HELPERS ====================== */
  
  function getSafeString_(val, maxLength, fallbackVal) {
    if (val == null || val === undefined) return fallbackVal;
    var str = String(val).trim(); return (str === '') ? fallbackVal : str.substring(0, maxLength);
  }

  function getUniqueUrls_(urlArray) {
    var unique = [];
    (urlArray || []).forEach(function(url) {
      url = (url || '').trim(); if (url && unique.indexOf(url) === -1) unique.push(url);
    });
    return unique;
  }

  function getUniqueAssets_(assetsArray) {
    var unique = []; var ids = {};
    for (var i = 0; i < assetsArray.length; i++) {
      if (!assetsArray[i]) continue;
      var assetId = assetsArray[i].getId();
      if (!ids[assetId]) { ids[assetId] = true; unique.push(assetsArray[i]); }
    }
    return unique;
  }

  /* ====================== CREATE AD ====================== */

  function createAdFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;

    var tasks = apiCall_('get', endpoint, null, null, CONFIG);
    if (!tasks || tasks.length === 0) return;

    var createdCount = 0; var lines = [];

    tasks.forEach(function(task) {
      try {
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
        if (!agIterator.hasNext()) return;

        Logger.log('[CREATE_AD] НАЧАЛО ОБРАБОТКИ ЗАДАНИЯ ID: ' + task.ad_id);
        var ts = new Date().getTime().toString().substring(7);
        var loadedSqAssets = []; var loadedRectAssets = [];

        var rawSqUrls = (task.square_image_urls && task.square_image_urls.length > 0) ? task.square_image_urls : [task.square_image_url || task.img_square || 'https://example.com/1x1.jpg'];
        getUniqueUrls_(rawSqUrls).forEach(function(url, idx) {
          try {
            var op = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(url).getBlob()).withName('Sq_' + ts + '_' + idx).build();
            if (op.isSuccessful()) loadedSqAssets.push(op.getResult());
          } catch(e) {}
        });

        var rawRectUrls = (task.landscape_image_urls && task.landscape_image_urls.length > 0) ? task.landscape_image_urls : [task.rectangle_image_url || task.img_rect || 'https://example.com/1.91x1.jpg'];
        getUniqueUrls_(rawRectUrls).forEach(function(url, idx) {
          try {
            var op = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(url).getBlob()).withName('Rect_' + ts + '_' + idx).build();
            if (op.isSuccessful()) loadedRectAssets.push(op.getResult());
          } catch(e) {}
        });

        loadedSqAssets = getUniqueAssets_(loadedSqAssets);
        loadedRectAssets = getUniqueAssets_(loadedRectAssets);

        if (loadedSqAssets.length === 0 || loadedRectAssets.length === 0) throw new Error('Не удалось загрузить ни одной валидной картинки (1:1 и 1.91:1).');

        Utilities.sleep(5000);
        var groupCount = 0;

        while (agIterator.hasNext()) {
          var adGroup = agIterator.next();
          var fUrl  = String(task.final_url || 'https://example.com').trim();
          if (fUrl.indexOf('http') !== 0) fUrl = 'https://' + fUrl; 

          var adBuilder = adGroup.newAd().responsiveDisplayAdBuilder()
            .withBusinessName(getSafeString_(task.business_name, 25, 'My Business'))
            .withFinalUrl(fUrl)
            .withLongHeadline(getSafeString_(task.long_headline, 90, 'Длинный заголовок'));

          var uniqueH = getUniqueUrls_((task.headlines && task.headlines.length > 0) ? task.headlines : [task.headline]);
          for (var h = 0; h < Math.min(uniqueH.length, 5); h++) adBuilder.addHeadline(getSafeString_(uniqueH[h], 30, 'Заголовок ' + (h+1)));

          var uniqueD = getUniqueUrls_((task.descriptions && task.descriptions.length > 0) ? task.descriptions : [task.description]);
          for (var d = 0; d < Math.min(uniqueD.length, 5); d++) adBuilder.addDescription(getSafeString_(uniqueD[d], 90, 'Описание ' + (d+1)));

          loadedSqAssets.forEach(function(asset) { adBuilder.addSquareMarketingImage(asset); });
          loadedRectAssets.forEach(function(asset) { adBuilder.addMarketingImage(asset); });
          if (loadedSqAssets.length > 0) adBuilder.addLogoImage(loadedSqAssets[0]);

          var adOperation = adBuilder.build();
          if (adOperation.isSuccessful()) groupCount++;
        }

        lines.push('📌 Создано объявление (Групп: ' + groupCount + ')');
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
        createdCount++;
      } catch(e) { 
        lines.push('⚠️ Ошибка (' + task.ad_id.substring(0,8) + '): ' + e.message); 
        patchSupabase_(CONFIG.TABLE_ADS, { needs_create: false, error_message: e.message.substring(0, 500) }, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      }
    });

    if (lines.length > 0) tgSend_('✅ <b>Create Ads</b>\nАкк: <code>' + myId + '</code>\nУспешно: ' + createdCount + '\n\n' + lines.join('\n'), CONFIG);
  }

  /* ====================== РЕЕСТРЫ И СИНХРОНИЗАЦИЯ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    var cleanId = acc.getCustomerId().replace(/-/g, '');
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
    if (CONFIG.PROJECT_ID) payload.project_id = CONFIG.PROJECT_ID; // Добавляем метку проекта если есть
    
    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];

    while (ads.hasNext()) {
      var ad = ads.next();
      var stats = ad.getStatsFor('TODAY');
      var headlines = (typeof ad.getName === 'function') ? ad.getName() : 'Ad #' + ad.getId();
      var adStatus = ad.isPaused() ? 'PAUSED' : 'ENABLED';
      var policyStatus = 'UNKNOWN';
      try { policyStatus = ad.getPolicyApprovalStatus(); } catch(e) {}

      var item = {
        ad_id: ad.getId().toString(), account_id: cleanId, campaign_name: ad.getCampaign().getName(),
        type: ad.getType(), headline: headlines.split(' | ')[0],
        final_url: ad.urls().getFinalUrl() || '', clicks: stats.getClicks(), cost: stats.getCost(),
        status: adStatus, policy_status: policyStatus, updated_at: new Date().toISOString()
      };
      if (CONFIG.PROJECT_ID) item.project_id = CONFIG.PROJECT_ID;
      
      batch.push(item);
      if (batch.length >= 50) { 
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG); 
        batch = []; 
      }
    }
    if (batch.length > 0) apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG);
  }
  
  function syncAssetPerformance_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var query = "SELECT asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, ad_group_ad_asset_view.field_type, metrics.clicks, metrics.impressions, metrics.cost_micros, metrics.conversions FROM ad_group_ad_asset_view WHERE metrics.impressions > 0";
    var report = AdsApp.report(query);
    var rows = report.rows();
    var assetData = {};

    while (rows.hasNext()) {
      var row = rows.next();
      var assetId = row['asset.id'];
      var type = row['asset.type'];
      var text = (type === 'TEXT') ? row['asset.text_asset.text'] : (type === 'IMAGE' ? row['asset.image_asset.full_size.url'] : '');
      if (!text) continue;

      if (!assetData[assetId]) {
        var item = {
          account_id: cleanId, asset_id: assetId, asset_text: text, field_type: row['ad_group_ad_asset_view.field_type'],
          clicks: 0, impressions: 0, cost: 0.0, conversions: 0.0
        };
        if (CONFIG.PROJECT_ID) item.project_id = CONFIG.PROJECT_ID;
        assetData[assetId] = item;
      }

      assetData[assetId].clicks += parseInt(row['metrics.clicks'], 10) || 0;
      assetData[assetId].impressions += parseInt(row['metrics.impressions'], 10) || 0;
      assetData[assetId].cost += (parseFloat(row['metrics.cost_micros']) || 0) / 1000000;
      assetData[assetId].conversions += parseFloat(row['metrics.conversions']) || 0;
    }

    var payload = []; for (var key in assetData) payload.push(assetData[key]);
    if (payload.length === 0) return;

    var batch = [];
    for (var i = 0; i < payload.length; i++) {
      batch.push(payload[i]);
      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ASSETS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        batch = [];
      }
    }
    if (batch.length > 0) apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ASSETS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncBidsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=target_cpc,needs_bid_sync';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;

    var data = apiCall_('get', endpoint, null, null, CONFIG);
    if (!data || data.length === 0 || !data[0].needs_bid_sync) return;

    var target = data[0].target_cpc;
    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (ags.hasNext()) ags.next().bidding().setCpc(target);
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_bid_sync: false }, 'uid=eq.' + cleanId, CONFIG);
  }

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_sync=eq.true';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;

    var edits = apiCall_('get', endpoint, null, null, CONFIG);
    if (!edits || edits.length === 0) return;

    edits.forEach(function(edit) {
      var adIterator = AdsApp.ads().withCondition('Id = ' + edit.ad_id).get();
      if (!adIterator.hasNext()) {
        if (edit.target_status === 'REMOVED') deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG);
        else patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false, edit_final_url: null, target_status: null }, 'ad_id=eq.' + edit.ad_id, CONFIG);
        return;
      }
      
      var ad = adIterator.next();
      if (edit.target_status === 'REMOVED') { ad.remove(); deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG); return; }
      if (edit.target_status === 'ENABLED') ad.enable();
      if (edit.target_status === 'PAUSED') ad.pause();
      if (edit.edit_final_url) ad.urls().setFinalUrl(edit.edit_final_url);

      patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false, edit_final_url: null, target_status: null }, 'ad_id=eq.' + edit.ad_id, CONFIG);
    });
  }

  function checkSafetyLimitsStrict_(acc, CONFIG) {
    var todayCost = acc.getStatsFor('TODAY').getCost();
    var totalLimit = CONFIG.SAFETY_LIMIT + CONFIG.EXTRA_LIMIT;
    var balance = 0;
    try {
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    if (todayCost >= totalLimit || (balance !== 0 && balance <= -totalLimit)) {
      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (campaigns.hasNext()) {
        var camp = campaigns.next();
        var ads = camp.ads().get();
        while (ads.hasNext()) ads.next().remove();
        camp.pause();
      }
      tgSend_('🛑 <b>CRITICAL STOP</b>\nAcc: ' + acc.getCustomerId() + '\nAds DELETED (' + totalLimit + '$).', CONFIG);
    }
  }

  /* ====================== API CORE ====================== */

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var headers = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (headersExtra) { for (var h in headersExtra) headers[h] = headersExtra[h]; }

    var res = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
    var code = res.getResponseCode();
    return (method === 'get' && code === 200 && res.getContentText().length > 0) ? JSON.parse(res.getContentText()) : null;
  }

  function patchSupabase_(table, data, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/' + table + '?' + query, { method: 'patch', contentType: 'application/json', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, payload: JSON.stringify(data), muteHttpExceptions: true });
  }

  function deleteSupabase_(table, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/' + table + '?' + query, { method: 'delete', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, muteHttpExceptions: true });
  }

  function tgSend_(txt, CONFIG) {
    if (!CONFIG.TG_TOKEN || !CONFIG.TG_CHAT_ID) return;
    try { UrlFetchApp.fetch('https://api.telegram.org/bot' + CONFIG.TG_TOKEN + '/sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: txt, parse_mode: 'HTML' }), muteHttpExceptions: true }); } catch(e) {}
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
