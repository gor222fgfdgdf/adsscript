/**
 * Google Ads Master Script (v16.27 - Smart Whitelist Reset & Mutate Fix)
 */

function runMain(ACCOUNT_CONFIG) {

  var SCRIPT_VERSION = 'v16.27';

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    PROJECT_ID:       (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PROJECT_ID) ? ACCOUNT_CONFIG.PROJECT_ID : null,

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',

    CONVERSION_NAME: 'Offline_Sale',

    SAFETY_LIMIT:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT : 45,
    EXTRA_LIMIT:             (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT  != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT  : 0,
    EMAIL:                   (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL               ) ? ACCOUNT_CONFIG.EMAIL        : ''
  };

  Logger.log('[SYSTEM] Версия скрипта: ' + SCRIPT_VERSION);
  Logger.log('[CONFIG] Project ID: ' + (CONFIG.PROJECT_ID || 'DEFAULT') + ' | SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e.message); }
  
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e.message); }
  try { ensureConversionAction_(CONFIG); }         catch (e) { Logger.log('[ERR][CONV_SETUP] ' + e.message); }

  try { revertCampaignsToCpc_(); }                 catch (e) { Logger.log('[ERR][REVERT_CPC] ' + e.message); }
  try { excludeUnknownAgeInAllGroups_(); }         catch (e) { Logger.log('[ERR][REVERT_AGE] ' + e.message); }

  try { syncTargetingStrategy_(myId, CONFIG); }    catch (e) { Logger.log('[ERR][TARGETING] ' + e.message); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e.message); }
  try { syncUnpauseFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][UNPAUSE] ' + e.message); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e.message); }
  
  try { updateAccountRegistry_(acc, CONFIG); }     catch (e) { Logger.log('[ERR][REGISTRY] ' + e.message); }
  try { syncAdsToRegistry_(myId, CONFIG); }        catch (e) { Logger.log('[ERR][SYNC_ADS] ' + e.message); }
  try { syncAssetPerformance_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][ASSETS] ' + e.message); }

  try { createAdFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][CREATE_AD] ' + e.message); }

  try { uploadConversionsFromEdge_(myId, CONFIG); } catch (e) { Logger.log('[ERR][CONVERSIONS] ' + e.message); }
  
  try { excludeYoutube_(); }                        catch (e) { Logger.log('[ERR][YOUTUBE] ' + e.message); }

  logDivider_('END');

  /* ====================== ВАЙТЛИСТ И БЛЕКЛИСТ ====================== */

  function syncTargetingStrategy_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var accData = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=account_type,blacklist_synced_at', null, null, CONFIG);
    var accType = (accData && accData.length > 0) ? accData[0].account_type : null;
    var lastSync = (accData && accData.length > 0) ? accData[0].blacklist_synced_at : null;

    if (accType === 'whitelist') {
      Logger.log('[TARGETING] Режим WHITELIST. Удаление тем...');
      var topics = AdsApp.display().topics().get();
      while (topics.hasNext()) topics.next().remove();
      
      // ПРОВЕРКА: Если площадок физически нет, сбрасываем время синхронизации
      var existingCount = 0;
      try {
        var query = "SELECT ad_group_criterion.criterion_id FROM ad_group_criterion WHERE ad_group.status = 'ENABLED' AND ad_group_criterion.type IN ('PLACEMENT', 'MOBILE_APP_CATEGORY') AND ad_group_criterion.negative = FALSE";
        var res = AdsApp.search(query);
        while(res.hasNext()) { res.next(); existingCount++; }
      } catch(e) {}

      if (existingCount === 0) {
        Logger.log('[WHITELIST] В группах нет площадок. Принудительная полная загрузка с нуля...');
        lastSync = null;
      }
      
      var endpoint = '/rest/v1/placement_whitelist?select=placement,created_at&limit=10000';
      if (lastSync) endpoint += '&created_at=gt.' + encodeURIComponent(lastSync);
      
      var data = apiCall_('get', endpoint, null, null, CONFIG);
      
      if (data && data.length > 0) {
        var customerId = cleanId;
        var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
        var targetGroups = [];
        while (ags.hasNext()) {
          targetGroups.push('customers/' + customerId + '/adGroups/' + ags.next().getId());
        }
        
        var operations = [];
        var maxCreatedAt = lastSync;
        
        data.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1) {
            var crit = {};
            if (item.placement.indexOf('mobileappcategory::') === 0) {
              crit = { mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategories/' + item.placement.split('::')[1] } };
            } else {
              crit = { placement: { url: item.placement } };
            }
            
            targetGroups.forEach(function(agResource) {
              var createObj = { adGroup: agResource, status: 'ENABLED' };
              if (crit.mobileAppCategory) createObj.mobileAppCategory = crit.mobileAppCategory;
              else createObj.placement = crit.placement;
              
              operations.push({ adGroupCriterionOperation: { create: createObj } });
            });
            
            if (!maxCreatedAt || item.created_at > maxCreatedAt) maxCreatedAt = item.created_at;
          }
        });
        
        if (operations.length > 0) {
          var chunk = [];
          for (var i = 0; i < operations.length; i++) {
            chunk.push(operations[i]);
            if (chunk.length >= 5000) {
              AdsApp.mutate(chunk);
              chunk = [];
            }
          }
          if (chunk.length > 0) AdsApp.mutate(chunk);
          
          Logger.log('[WHITELIST] Прямая загрузка Mutate выполнена. Инъекций таргетинга: ' + operations.length);
          patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAt }, 'uid=eq.' + cleanId, CONFIG);
        }
      } else {
        Logger.log('[WHITELIST] Нет новых площадок для синхронизации.');
      }
    } else {
      Logger.log('[TARGETING] Режим BLACKLIST. Восстановление топиков...');
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
              break;
            }
          }
          if (!found) ag.display().newTopicBuilder().withTopicId(16).build();
        } catch(e) {}
      }

      var oldListName = 'Global Supabase Blacklist V6';
      var newListName = 'Global Supabase Blacklist V7';

      var oldListIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + oldListName + "'").get();
      if (oldListIterator.hasNext()) {
        var oldList = oldListIterator.next();
        var linkedCamps = oldList.campaigns().get();
        while (linkedCamps.hasNext()) {
          try { linkedCamps.next().removeExcludedPlacementList(oldList); } catch(e) {}
        }
      }

      var excludedList;
      var isNewList = false;
      var listIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + newListName + "'").get();
      
      if (listIterator.hasNext()) {
        excludedList = listIterator.next();
      } else {
        excludedList = AdsApp.newExcludedPlacementListBuilder().withName(newListName).build().getResult();
        isNewList = true;
        lastSync = null; 
      }

      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
      while (campaigns.hasNext()) {
        try { campaigns.next().addExcludedPlacementList(excludedList); } catch (e) {}
      }

      var endpointBl = '/rest/v1/placement_blacklist?select=placement,created_at&limit=10000';
      if (CONFIG.PROJECT_ID) endpointBl += '&project_id=eq.' + CONFIG.PROJECT_ID;
      if (lastSync) endpointBl += '&created_at=gt.' + encodeURIComponent(lastSync);

      var dataBl = apiCall_('get', endpointBl, null, null, CONFIG);
      var GAME_CATEGORIES = ['mobileappcategory::60008', 'mobileappcategory::60506'];
      var columnsBl = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
      var uploadBl = AdsApp.bulkUploads().newCsvUpload(columnsBl);
      var addedCountBl = 0;
      var maxCreatedAtBl = lastSync;

      if (isNewList) {
        GAME_CATEGORIES.forEach(function(item) {
          uploadBl.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item });
          addedCountBl++;
        });
      }

      if (dataBl && dataBl.length > 0) {
        dataBl.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1 && GAME_CATEGORIES.indexOf(item.placement) === -1) {
            uploadBl.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement });
            addedCountBl++;
            if (!maxCreatedAtBl || item.created_at > maxCreatedAtBl) maxCreatedAtBl = item.created_at;
          }
        });
      }

      if (addedCountBl > 0) {
        uploadBl.apply();
        Logger.log('[BLACKLIST] В список исключений отправлено: ' + addedCountBl);
        if (maxCreatedAtBl) patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAtBl }, 'uid=eq.' + cleanId, CONFIG);
      } else {
        Logger.log('[BLACKLIST] Нет новых площадок для исключения.');
      }
    }
  }

  /* ====================== ОТКАТ НА MANUAL CPC ====================== */

  function revertCampaignsToCpc_() {
    Logger.log('[REVERT] Возврат кампаний на MANUAL_CPC...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var revertedCount = 0;

    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      var strategy = camp.bidding().getStrategyType();
      
      if (strategy !== 'MANUAL_CPC') {
        try {
          camp.bidding().setStrategy('MANUAL_CPC');
          Logger.log('[REVERT] Кампания "' + camp.getName() + '" переведена обратно на MANUAL_CPC.');
          revertedCount++;
        } catch (e) {
          Logger.log('[REVERT] Ошибка возврата: ' + e.message);
        }
      }
    }
    
    if (revertedCount === 0) {
      Logger.log('[REVERT] Все активные кампании уже на MANUAL_CPC.');
    }
  }

  /* ====================== ВОССТАНОВЛЕНИЕ БЛОКИРОВКИ ВОЗРАСТА ====================== */

  function excludeUnknownAgeInAllGroups_() {
    Logger.log('[DEMOGRAPHICS] Блокировка возраста "Неизвестно"...');
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var count = 0;

    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + ag.getId();
      
      try {
        AdsApp.mutate({
          adGroupCriterionOperation: {
            create: { 
              adGroup: adGroupResourceName, 
              status: 'ENABLED', 
              negative: true, 
              ageRange: { type: 'AGE_RANGE_UNDETERMINED' } 
            }
          }
        });
        count++;
        Logger.log('[DEMOGRAPHICS] Возраст "Неизвестно" запрещен в группе: ' + ag.getName());
      } catch(e) {}
    }
    
    if (count === 0) {
      Logger.log('[DEMOGRAPHICS] Возраст "Неизвестно" уже заблокирован везде.');
    }
  }

  /* ====================== ДИСТАНЦИОННОЕ СНЯТИЕ С ПАУЗЫ ====================== */

  function syncUnpauseFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=needs_unpause_groups';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    
    var data = apiCall_('get', endpoint, null, null, CONFIG);
    
    if (!data || data.length === 0 || !data[0].needs_unpause_groups) return; 

    Logger.log('[UNPAUSE] Получена команда из БД! Включаем остановленные группы...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var unpausedCount = 0;

    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      var pausedAgs = camp.adGroups().withCondition('Status = PAUSED').get();
      while (pausedAgs.hasNext()) {
        pausedAgs.next().enable();
        unpausedCount++;
      }
    }
    
    Logger.log('[UNPAUSE] Успешно включено групп: ' + unpausedCount);
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_unpause_groups: false }, 'uid=eq.' + cleanId, CONFIG);
  }

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
          create: {
            name: CONFIG.CONVERSION_NAME,
            type: 'UPLOAD_CLICKS', 
            category: 'PURCHASE',  
            status: 'ENABLED'
          }
        }
      });
      Logger.log('[SETUP] Оффлайн-конверсия успешно создана!');
    } catch (e) {
      Logger.log('[SETUP] Ошибка автоматического создания конверсии: ' + e.message);
    }
  }

  /* ====================== АВТОСОЗДАНИЕ ГРУППЫ И ТЕМ ====================== */

  function maybeCreateDefaultAdGroup_() {
    Logger.log('[SETUP] Проверка наличия групп объявлений...');
    var agCheck = AdsApp.adGroups().withCondition("Status != REMOVED").get();
    if (agCheck.hasNext()) {
      Logger.log('[SETUP] Группы уже существуют. Пропуск создания.');
      return;
    }

    var CAMPAIGN_NAME = 'Display-1';
    var CPC_BID = 0.02;
    var AD_GROUP_NAME = 'Topic_All';

    var EXCLUDE_AGE_RANGES = [ 'AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44', 'AGE_RANGE_45_54', 'AGE_RANGE_UNDETERMINED' ];

    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var campaignIterator = AdsApp.campaigns().withCondition('Name = "' + CAMPAIGN_NAME + '"').get();

    if (!campaignIterator.hasNext()) {
      Logger.log('[SETUP] Кампания ' + CAMPAIGN_NAME + ' не найдена.');
      return;
    }

    var campaign = campaignIterator.next();
    var adGroupResult = campaign.newAdGroupBuilder().withName(AD_GROUP_NAME).withCpc(CPC_BID).build();

    if (!adGroupResult.isSuccessful()) return;

    var adGroup = adGroupResult.getResult();

    var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + adGroup.getId();
    for (var a = 0; a < EXCLUDE_AGE_RANGES.length; a++) {
      try {
        AdsApp.mutate({
          adGroupCriterionOperation: {
            create: { adGroup: adGroupResourceName, status: 'ENABLED', negative: true, ageRange: { type: EXCLUDE_AGE_RANGES[a] } }
          }
        });
      } catch(e) {}
    }
    Logger.log('[SETUP] Базовая группа успешно настроена.');
  }

  /* ====================== ИСКЛЮЧЕНИЕ YOUTUBE ====================== */

  function excludeYoutube_() {
    Logger.log('[YOUTUBE] Проверка принудительного исключения доменов YouTube...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var campCount = 0;
    var urlsToExclude = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
    
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      campCount++;
      
      urlsToExclude.forEach(function(url) {
        try {
          var op = camp.display().newPlacementBuilder().withUrl(url).exclude();
          if (op.isSuccessful()) {
            Logger.log('[YOUTUBE] ' + url + ' успешно исключен на уровне кампании: ' + camp.getName());
          } else {
            fallbackYoutubeToAdGroups_(camp, url);
          }
        } catch (e) {
          fallbackYoutubeToAdGroups_(camp, url);
        }
      });
    }
    if (campCount === 0) Logger.log('[YOUTUBE] Нет активных КМС кампаний для обработки.');
  }

  function fallbackYoutubeToAdGroups_(camp, url) {
    var adGroups = camp.adGroups().withCondition('Status = ENABLED').get();
    var agCount = 0;
    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      try {
        var op = ag.display().newPlacementBuilder().withUrl(url).exclude();
        if (op.isSuccessful()) agCount++;
      } catch(e) {}
    }
    if (agCount > 0) Logger.log('[YOUTUBE] Фолбэк: ' + url + ' исключен в ' + agCount + ' группах объявлений.');
  }

  /* ====================== OFFLINE CONVERSIONS ====================== */

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;
    
    var cleanId = myId.replace(/-/g, '');
    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    var fetchUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks?uid=' + cleanId;
    
    var getRes = UrlFetchApp.fetch(fetchUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
    var resCode = getRes.getResponseCode();
    var resText = getRes.getContentText();

    if (resCode !== 200) return;
    var data = JSON.parse(resText);
    if (!data || !data.conversions || data.conversions.length === 0) return;

    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();

    var uploadedIds = [];

    data.conversions.forEach(function(c) {
      var targetAcc = (c.account_uid || '').replace(/-/g, '');
      var gclid = c.gclid || '';
      var isMatch = (targetAcc === cleanId);

      if (!isMatch || !c.gclid) return;

      var convTime = c.external_timestamp ? c.external_timestamp.replace('T', ' ') + '+0100' : '';
      var payout = c.payout || 0;
      var currency = c.currency || 'USD';

      upload.append({
        'Google Click ID': c.gclid, 
        'Conversion Name': CONFIG.CONVERSION_NAME,
        'Conversion Time': convTime,
        'Conversion Value': payout, 
        'Conversion Currency': currency
      });
      uploadedIds.push(c.id);
    });

    if (uploadedIds.length > 0) {
      upload.apply();
      var postUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks';
      UrlFetchApp.fetch(postUrl, { method: 'post', headers: headers, payload: JSON.stringify({ ids: uploadedIds }), muteHttpExceptions: true });
    }
  }

  /* ====================== ХЕЛПЕРЫ ====================== */
  
  function getSafeString_(val, maxLength, fallbackVal) {
    if (val == null || val === undefined) return fallbackVal;
    var str = String(val).trim();
    if (str === '') return fallbackVal;
    return str.substring(0, maxLength);
  }

  function getUniqueUrls_(urlArray) {
    if (!urlArray || urlArray.length === 0) return [];
    var unique = [];
    for (var i = 0; i < urlArray.length; i++) {
      var url = (urlArray[i] || '').trim();
      if (url && unique.indexOf(url) === -1) unique.push(url);
    }
    return unique;
  }

  function getUniqueAssets_(assetsArray) {
    var unique = [];
    var ids = {};
    for (var i = 0; i < assetsArray.length; i++) {
      if (!assetsArray[i]) continue;
      var assetId = assetsArray[i].getId();
      if (!ids[assetId]) {
        ids[assetId] = true;
        unique.push(assetsArray[i]);
      }
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

    tasks.forEach(function(task) {
      try {
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
        if (!agIterator.hasNext()) return;
        
        var ts = new Date().getTime().toString().substring(7);
        var loadedSqAssets = [];
        var loadedRectAssets = [];

        var rawSqUrls = (task.square_image_urls && task.square_image_urls.length > 0) ? task.square_image_urls : [task.square_image_url || task.img_square || 'https://example.com/1x1.jpg'];
        var sqUrls = getUniqueUrls_(rawSqUrls);
        
        sqUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder().withData(blob).withName('Sq_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx).build();
            if (op.isSuccessful()) loadedSqAssets.push(op.getResult());
          } catch(e) {}
        });

        var rawRectUrls = (task.landscape_image_urls && task.landscape_image_urls.length > 0) ? task.landscape_image_urls : [task.rectangle_image_url || task.img_rect || 'https://example.com/1.91x1.jpg'];
        var rectUrls = getUniqueUrls_(rawRectUrls);

        rectUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder().withData(blob).withName('Rect_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx).build();
            if (op.isSuccessful()) loadedRectAssets.push(op.getResult());
          } catch(e) {}
        });

        loadedSqAssets = getUniqueAssets_(loadedSqAssets);
        loadedRectAssets = getUniqueAssets_(loadedRectAssets);
        if (loadedSqAssets.length === 0 || loadedRectAssets.length === 0) throw new Error('Images fail');

        Utilities.sleep(5000);

        while (agIterator.hasNext()) {
          var adGroup = agIterator.next();
          var bName = getSafeString_(task.business_name, 25, 'My Business');
          var fUrl  = String(task.final_url || 'https://example.com').trim();
          if (fUrl.indexOf('http') !== 0) fUrl = 'https://' + fUrl; 
          var lHead = getSafeString_(task.long_headline, 90, 'Длинный заголовок');

          var adBuilder = adGroup.newAd().responsiveDisplayAdBuilder().withBusinessName(bName).withFinalUrl(fUrl).withLongHeadline(lHead);
          var headlinesList = (task.headlines && task.headlines.length > 0) ? task.headlines : [task.headline];
          var uniqueH = getUniqueUrls_(headlinesList);
          for (var h = 0; h < Math.min(uniqueH.length, 5); h++) adBuilder.addHeadline(getSafeString_(uniqueH[h], 30, 'H ' + (h+1)));

          var descList = (task.descriptions && task.descriptions.length > 0) ? task.descriptions : [task.description];
          var uniqueD = getUniqueUrls_(descList);
          for (var d = 0; d < Math.min(uniqueD.length, 5); d++) adBuilder.addDescription(getSafeString_(uniqueD[d], 90, 'D ' + (d+1)));

          loadedSqAssets.forEach(function(asset) { adBuilder.addSquareMarketingImage(asset); });
          loadedRectAssets.forEach(function(asset) { adBuilder.addMarketingImage(asset); });
          if (loadedSqAssets.length > 0) adBuilder.addLogoImage(loadedSqAssets[0]);
          adBuilder.build();
        }

        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      } catch(e) { 
        patchSupabase_(CONFIG.TABLE_ADS, { needs_create: false, error_message: e.message.substring(0, 500), error_at: new Date().toISOString() }, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      }
    });
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
    if (CONFIG.PROJECT_ID) payload.project_id = CONFIG.PROJECT_ID;
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
      try { 
        policyStatus = ad.getPolicyApprovalStatus(); 
        if (policyStatus === 'DISAPPROVED' || policyStatus === 'APPROVED_LIMITED') {
          var topics = ad.getPolicyTopics();
          if (topics && topics.length > 0) {
            var reasons = [];
            for (var t = 0; t < topics.length; t++) reasons.push(topics[t].getId());
            if (reasons.length > 0) policyStatus += ' (' + reasons.join(', ') + ')';
          }
        }
      } catch(e) {}

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
      var fieldType = row['ad_group_ad_asset_view.field_type'];
      var text = '';
      if (type === 'TEXT') text = row['asset.text_asset.text'] || '';
      else if (type === 'IMAGE') text = row['asset.image_asset.full_size.url'] || '';
      else continue; 

      var clicks = parseInt(row['metrics.clicks'], 10) || 0;
      var impressions = parseInt(row['metrics.impressions'], 10) || 0;
      var cost = (parseFloat(row['metrics.cost_micros']) || 0) / 1000000;
      var conv = parseFloat(row['metrics.conversions']) || 0;

      if (!assetData[assetId]) {
        var item = { account_id: cleanId, asset_id: assetId, asset_text: text, field_type: fieldType, clicks: 0, impressions: 0, cost: 0.0, conversions: 0.0 };
        if (CONFIG.PROJECT_ID) item.project_id = CONFIG.PROJECT_ID;
        assetData[assetId] = item;
      }
      assetData[assetId].clicks += clicks;
      assetData[assetId].impressions += impressions;
      assetData[assetId].cost += cost;
      assetData[assetId].conversions += conv;
    }

    var payload = [];
    for (var key in assetData) payload.push(assetData[key]);
    if (payload.length === 0) return;

    var batch = [];
    for (var i = 0; i < payload.length; i++) {
      batch.push(payload[i]);
      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/asset_performance', batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        batch = [];
      }
    }
    if (batch.length > 0) apiCall_('post', '/rest/v1/asset_performance', batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncBidsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=target_cpc,needs_bid_sync';
    if (CONFIG.PROJECT_ID) endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    
    var data = apiCall_('get', endpoint, null, null, CONFIG);
    if (!data || data.length === 0 || !data[0].needs_bid_sync) return;

    var target = data[0].target_cpc;
    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (ags.hasNext()) {
      var ag = ags.next();
      if (ag.getCampaign().bidding().getStrategyType() === 'MANUAL_CPC') ag.bidding().setCpc(target);
    }
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
      if (edit.target_status === 'REMOVED') {
        ad.remove();
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG);
        return;
      }

      if (edit.target_status === 'ENABLED') ad.enable();
      if (edit.target_status === 'PAUSED') ad.pause();
      if (edit.edit_final_url) ad.urls().setFinalUrl(edit.edit_final_url);
      patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false, edit_final_url: null, target_status: null }, 'ad_id=eq.' + edit.ad_id, CONFIG);
    });
  }

  function checkSafetyLimitsStrict_(acc, CONFIG) {
    var todayCost  = acc.getStatsFor('TODAY').getCost();
    var totalLimit = CONFIG.SAFETY_LIMIT + CONFIG.EXTRA_LIMIT;
    var balance    = 0;

    try {
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    if (todayCost >= totalLimit || (balance !== 0 && balance <= -totalLimit)) {
      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (campaigns.hasNext()) {
        var camp = campaigns.next();
        var ads  = camp.ads().get();
        while (ads.hasNext()) { ads.next().remove(); }
        camp.pause();
      }
    }
  }

  /* ====================== API CORE ====================== */

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var headers = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };
    if (headersExtra) { for (var h in headersExtra) headers[h] = headersExtra[h]; }

    var res = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
    var code = res.getResponseCode();
    var text = res.getContentText();
    return (method === 'get' && code === 200 && text.length > 0) ? JSON.parse(text) : null;
  }

  function patchSupabase_(table, data, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var endpoint = '/rest/v1/' + table + '?' + query;
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: 'patch', contentType: 'application/json', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, payload: JSON.stringify(data), muteHttpExceptions: true });
  }

  function deleteSupabase_(table, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var endpoint = '/rest/v1/' + table + '?' + query;
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: 'delete', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, muteHttpExceptions: true });
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
