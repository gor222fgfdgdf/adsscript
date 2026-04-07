/**
 * Google Ads Master Script (v16.12 - Version Logging)
 */

function runMain(ACCOUNT_CONFIG) {

  var CONFIG = {
    VERSION:          '16.12',
    SUPABASE_URL:     'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    PROJECT_ID:       (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PROJECT_ID) ? ACCOUNT_CONFIG.PROJECT_ID : null,

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',

    TG_TOKEN:         '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID:       37742949,

    CONVERSION_NAME:  'Offline_Sale',
    
    // SMART BID UPGRADE SETTINGS
    MIN_CONVERSIONS_FOR_CPA: 10,
    TARGET_CPA:              0.1,

    SAFETY_LIMIT:     (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT : 45,
    EXTRA_LIMIT:      (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT  != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT  : 0,
    EMAIL:            (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL               ) ? ACCOUNT_CONFIG.EMAIL        : ''
  };

  Logger.log('[CONFIG] Script Version: v' + CONFIG.VERSION + ' | Project ID: ' + (CONFIG.PROJECT_ID || 'DEFAULT') + ' | SAFETY_LIMIT=' + CONFIG.SAFETY_LIMIT + ' EXTRA_LIMIT=' + CONFIG.EXTRA_LIMIT);

  var acc  = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e.message); }
  
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e.message); }
  try { ensureNewsTopicInAllGroups_(); }           catch (e) { Logger.log('[ERR][TOPICS] ' + e.message); }
  try { ensureConversionAction_(CONFIG); }         catch (e) { Logger.log('[ERR][CONV_SETUP] ' + e.message); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e.message); }
  try { autoUpgradeBiddingStrategy_(CONFIG); }     catch (e) { Logger.log('[ERR][BID_UPGRADE] ' + e.message); }
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

  /* ====================== АВТОРЕЖИМ СТРАТЕГИИ И ДЕМОГРАФИИ ====================== */

  function autoUpgradeBiddingStrategy_(CONFIG) {
    Logger.log('[BID_UPGRADE] Проверка смарт-стратегий и демографии...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var upgradedCount = 0;
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var expectedMicros = Math.round(CONFIG.TARGET_CPA * 1000000);

    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      
      // Запрашиваем через GAQL точные данные по стратегии и ставке
      var query = "SELECT campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = " + camp.getId();
      var res = AdsApp.search(query);
      if (!res.hasNext()) continue;
      
      var row = res.next();
      var strategyType = row.campaign.bidding_strategy_type;
      var targetCpaMicros = (row.campaign.maximize_conversions && row.campaign.maximize_conversions.target_cpa_micros) ? parseInt(row.campaign.maximize_conversions.target_cpa_micros, 10) : 0;
      
      var isConversionStrategy = (strategyType === 'TARGET_CPA' || strategyType === 'MAXIMIZE_CONVERSIONS');
      var conversions = camp.getStatsFor('ALL_TIME').getConversions();
      
      var needsUpgrade = false;
      
      // Случай 1: Кампания еще на ручной ставке
      if (!isConversionStrategy && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      } 
      // Случай 2: Кампания уже переключена, но Target CPA не задан или отличается от конфига
      else if (strategyType === 'MAXIMIZE_CONVERSIONS' && targetCpaMicros !== expectedMicros && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      }

      if (needsUpgrade) {
        Logger.log('[BID_UPGRADE] 📈 Обработка кампании "' + camp.getName() + '" (' + conversions + ' конв.). Применяем Target CPA = ' + CONFIG.TARGET_CPA);
        try {
          // ОДИН прямой запрос, который меняет И стратегию, И ставку одновременно
          AdsApp.mutate({
            campaignOperation: {
              update: {
                resourceName: 'customers/' + customerId + '/campaigns/' + camp.getId(),
                maximizeConversions: { targetCpaMicros: expectedMicros }
              },
              updateMask: 'maximizeConversions' // Указываем Гуглу применить весь объект стратегии целиком
            }
          });
          
          upgradedCount++;
          isConversionStrategy = true; // Отмечаем для демографии ниже
          Logger.log('[BID_UPGRADE] ✅ Стратегия и ставка успешно установлены!');
        } catch (e) {
          Logger.log('[BID_UPGRADE] ❌ Ошибка переключения: ' + e.message);
        }
      }

      // Если кампания стала конверсионной, открываем возраст "Неизвестно"
      if (isConversionStrategy) {
        try {
          var qDemo = "SELECT ad_group_criterion.resource_name, ad_group.name " +
                      "FROM ad_group_criterion " +
                      "WHERE campaign.id = " + camp.getId() + " " +
                      "AND ad_group_criterion.type = 'AGE_RANGE' " +
                      "AND ad_group_criterion.negative = TRUE " +
                      "AND ad_group_criterion.age_range.type = 'AGE_RANGE_UNDETERMINED'";
          
          var searchDemo = AdsApp.search(qDemo);
          while (searchDemo.hasNext()) {
            var rowDemo = searchDemo.next();
            AdsApp.mutate({ adGroupCriterionOperation: { remove: rowDemo.ad_group_criterion.resource_name } });
            Logger.log('[DEMOGRAPHICS] 🔓 Разрешен возраст "Неизвестно" в группе: ' + rowDemo.ad_group.name);
          }
        } catch(e) {}
      }
    }
    
    if (upgradedCount === 0) {
      Logger.log('[BID_UPGRADE] Изменение ставок пока не требуется.');
    }
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
      Logger.log('[SETUP] ✅ Оффлайн-конверсия успешно создана!');
    } catch (e) {
      Logger.log('[SETUP] ❌ Ошибка автоматического создания конверсии: ' + e.message);
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
      Logger.log('[SETUP] ❌ Кампания ' + CAMPAIGN_NAME + ' не найдена.');
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
    Logger.log('[SETUP] ✅ Базовая группа успешно настроена.');
  }

  function ensureNewsTopicInAllGroups_() {
    Logger.log('[TOPICS] Проверка наличия топика News (ID 16) во всех активных группах...');
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    var addedCount = 0;
    var restoredCount = 0;

    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      try {
        var existingTopics = ag.display().topics().get();
        var found = false;
        
        while (existingTopics.hasNext()) {
          var t = existingTopics.next();
          if (t.getTopicId() === 16) {
            found = true;
            if (t.isPaused() || !t.isEnabled()) {
              t.enable();
              restoredCount++;
              Logger.log('[TOPICS] 🔄 Топик News восстановлен/включен в группе: ' + ag.getName());
            }
            break;
          }
        }

        if (!found) {
          var op = ag.display().newTopicBuilder().withTopicId(16).build();
          if (op.isSuccessful()) {
            Logger.log('[TOPICS] ➕ Топик News добавлен в группу: ' + ag.getName());
            addedCount++;
          }
        }
      } catch(e) {
        Logger.log('[TOPICS] ⚠️ Ошибка при работе с группой ' + ag.getName() + ': ' + e.message);
      }
    }
    Logger.log('[TOPICS] Готово. Создано новых: ' + addedCount + '. Восстановлено: ' + restoredCount + '.');
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
            Logger.log('[YOUTUBE] ✅ ' + url + ' успешно исключен на уровне кампании: ' + camp.getName());
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
    if (agCount > 0) Logger.log('[YOUTUBE] ↪️ Фолбэк: ' + url + ' исключен в ' + agCount + ' группах объявлений.');
  }

  /* ====================== GLOBAL BLACKLIST DELTA SYNC ====================== */

  function syncPlacementBlacklist_(myId, CONFIG) {
    Logger.log('[BLACKLIST] Проверка статуса синхронизации...');
    var cleanId = myId.replace(/-/g, '');
    
    var accData = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=blacklist_synced_at', null, null, CONFIG);
    var lastSync = (accData && accData.length > 0) ? accData[0].blacklist_synced_at : null;

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
      Logger.log('[BLACKLIST] Создан НОВЫЙ список исключений: ' + newListName);
      isNewList = true;
      lastSync = null; 
    }

    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (campaigns.hasNext()) {
      try { campaigns.next().addExcludedPlacementList(excludedList); } catch (e) {}
    }

    var endpoint = '/rest/v1/placement_blacklist?select=placement,created_at&limit=10000';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    if (lastSync) {
      endpoint += '&created_at=gt.' + encodeURIComponent(lastSync);
      Logger.log('[BLACKLIST] Запрос только НОВЫХ площадок (добавленных после ' + lastSync + ')');
    } else {
      Logger.log('[BLACKLIST] Запрос ВСЕЙ базы площадок (первичная загрузка списка V7)');
    }

    var data = apiCall_('get', endpoint, null, null, CONFIG);

    var GAME_CATEGORIES = ['mobileappcategory::60008', 'mobileappcategory::60506'];
    var columns = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    var addedCount = 0;
    var maxCreatedAt = lastSync;

    if (isNewList) {
      GAME_CATEGORIES.forEach(function(item) {
        upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item });
        addedCount++;
      });
    }

    if (data && data.length > 0) {
      data.forEach(function(item) {
        if (item.placement && item.placement.indexOf('youtube.com') === -1 && GAME_CATEGORIES.indexOf(item.placement) === -1) { 
          upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement });
          addedCount++;
          
          if (!maxCreatedAt || item.created_at > maxCreatedAt) {
            maxCreatedAt = item.created_at;
          }
        }
      });
    }

    if (addedCount > 0) {
      upload.apply();
      Logger.log('[BLACKLIST] Bulk Upload запущен. Строк отправлено: ' + addedCount);
      
      if (maxCreatedAt) {
        patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAt }, 'uid=eq.' + cleanId, CONFIG);
        Logger.log('[BLACKLIST] Время синхронизации в БД обновлено: ' + maxCreatedAt);
      }
    } else {
      Logger.log('[BLACKLIST] Нет новых площадок для загрузки.');
    }
  }

  /* ====================== OFFLINE CONVERSIONS ====================== */

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) {
      Logger.log('[CONVERSIONS] ⚠️ Пропуск: Имя конверсии не задано в CONFIG.');
      return;
    }
    
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[CONVERSIONS] === СТАРТ ПРОВЕРКИ КОНВЕРСИЙ ===');
    Logger.log('[CONVERSIONS] Целевая конверсия: ' + CONFIG.CONVERSION_NAME);
    Logger.log('[CONVERSIONS] Текущий ID аккаунта (очищенный): ' + cleanId);

    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    
    var fetchUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks?uid=' + cleanId;
    Logger.log('[CONVERSIONS] GET Запрос к: ' + fetchUrl);
    
    var getRes = UrlFetchApp.fetch(fetchUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
    var resCode = getRes.getResponseCode();
    var resText = getRes.getContentText();

    Logger.log('[CONVERSIONS] Код ответа сервера: ' + resCode);
    Logger.log('[CONVERSIONS] Тело ответа (первые 200 симв.): ' + resText.substring(0, 200));

    if (resCode !== 200) {
      Logger.log('[CONVERSIONS] ❌ Ошибка сервера БД при получении конверсий.');
      return;
    }
    
    var data = JSON.parse(resText);
    if (!data || !data.conversions || data.conversions.length === 0) {
      Logger.log('[CONVERSIONS] Новых конверсий в базе не найдено.');
      return;
    }

    Logger.log('[CONVERSIONS] Всего конверсий в ответе БД: ' + data.conversions.length);

    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();

    var uploadedIds = [];

    data.conversions.forEach(function(c, index) {
      var targetAcc = (c.account_uid || '').replace(/-/g, '');
      var gclid = c.gclid || 'ПУСТО';
      var isMatch = (targetAcc === cleanId);

      Logger.log('[CONVERSIONS] [' + index + '] Проверка: GCLID=' + gclid + ', Acc=' + targetAcc + ' -> Совпадение: ' + isMatch);

      if (!isMatch || !c.gclid) return;

      var convTime = c.external_timestamp ? c.external_timestamp.replace('T', ' ') + '+0100' : 'ПУСТО';
      var payout = c.payout || 0;
      var currency = c.currency || 'USD';

      Logger.log('[CONVERSIONS] [' + index + '] ✅ Добавляем в выгрузку: Time=' + convTime + ', Value=' + payout + ' ' + currency);

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
      Logger.log('[CONVERSIONS] Запуск upload.apply(). Ожидание отправки...');
      upload.apply();
      Logger.log('[CONVERSIONS] Данные отправлены в Google Ads. Кол-во: ' + uploadedIds.length);
      
      Logger.log('[CONVERSIONS] Отправка подтверждения в БД по ID: ' + JSON.stringify(uploadedIds));
      
      var postUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks';
      var postRes = UrlFetchApp.fetch(postUrl, { 
        method: 'post', 
        headers: headers, 
        payload: JSON.stringify({ ids: uploadedIds }), 
        muteHttpExceptions: true 
      });
      Logger.log('[CONVERSIONS] Ответ БД на подтверждение: Code ' + postRes.getResponseCode() + ' | Body: ' + postRes.getContentText().substring(0, 100));
    } else {
      Logger.log('[CONVERSIONS] Нет конверсий для отправки в текущий аккаунт (' + cleanId + ').');
    }
    
    Logger.log('[CONVERSIONS] === КОНЕЦ ПРОВЕРКИ КОНВЕРСИЙ ===');
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
      if (url && unique.indexOf(url) === -1) {
        unique.push(url);
      }
    }
    return unique;
  }

  function getUniqueAssets_(assetsArray) {
    var unique = [];
    var ids = {};
    for (var i = 0; i < assetsArray.length; i++) {
      if (!assetsArray[i]) continue; // ЗАЩИТА ОТ NULL
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
    Logger.log('[CREATE_AD] Проверка заданий на создание новых объявлений...');
    var cleanId = myId.replace(/-/g, '');
    
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    
    var tasks = apiCall_('get', endpoint, null, null, CONFIG);

    if (!tasks || tasks.length === 0) {
      Logger.log('[CREATE_AD] Заданий на создание нет.');
      return;
    }

    var createdCount = 0;
    var lines = [];

    tasks.forEach(function(task) {
      try {
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
        if (!agIterator.hasNext()) {
          Logger.log('[CREATE_AD] Нет активных групп объявлений КМС.');
          return;
        }

        Logger.log('--------------------------------------------------');
        Logger.log('[CREATE_AD] НАЧАЛО ОБРАБОТКИ ЗАДАНИЯ ID: ' + task.ad_id);
        
        var ts = new Date().getTime().toString().substring(7);
        var loadedSqAssets = [];
        var loadedRectAssets = [];

        var rawSqUrls = (task.square_image_urls && task.square_image_urls.length > 0) ? task.square_image_urls : [task.square_image_url || task.img_square || 'https://example.com/1x1.jpg'];
        var sqUrls = getUniqueUrls_(rawSqUrls);
        
        sqUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder()
              .withData(blob)
              .withName('Sq_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx)
              .build();
            if (op.isSuccessful()) {
              loadedSqAssets.push(op.getResult());
            } else {
              Logger.log('[CREATE_AD] ⚠️ Google отклонил квадратную картинку (' + url + '): ' + op.getErrors().join(', '));
            }
          } catch(e) {
            Logger.log('[CREATE_AD] ⚠️ Ошибка скачивания квадратной картинки (' + url + '): ' + e.message);
          }
        });

        var rawRectUrls = (task.landscape_image_urls && task.landscape_image_urls.length > 0) ? task.landscape_image_urls : [task.rectangle_image_url || task.img_rect || 'https://example.com/1.91x1.jpg'];
        var rectUrls = getUniqueUrls_(rawRectUrls);

        rectUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder()
              .withData(blob)
              .withName('Rect_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx)
              .build();
            if (op.isSuccessful()) {
              loadedRectAssets.push(op.getResult());
            } else {
              Logger.log('[CREATE_AD] ⚠️ Google отклонил горизонтальную картинку (' + url + '): ' + op.getErrors().join(', '));
            }
          } catch(e) {
            Logger.log('[CREATE_AD] ⚠️ Ошибка скачивания горизонтальной картинки (' + url + '): ' + e.message);
          }
        });

        loadedSqAssets = getUniqueAssets_(loadedSqAssets);
        loadedRectAssets = getUniqueAssets_(loadedRectAssets);

        if (loadedSqAssets.length === 0 || loadedRectAssets.length === 0) {
          throw new Error('Не удалось загрузить ни одной валидной картинки (нужна хотя бы 1 квадратная и 1 горизонтальная).');
        }

        Logger.log('[CREATE_AD] Успешно загружено: ' + loadedSqAssets.length + ' кв., ' + loadedRectAssets.length + ' гор. Синхронизация (5 сек)...');
        Utilities.sleep(5000);

        var groupCount = 0;

        while (agIterator.hasNext()) {
          var adGroup = agIterator.next();
          
          var bName = getSafeString_(task.business_name, 25, 'My Business');
          var fUrl  = String(task.final_url || 'https://example.com').trim();
          if (fUrl.indexOf('http') !== 0) fUrl = 'https://' + fUrl; 
          var lHead = getSafeString_(task.long_headline, 90, 'Длинный заголовок по умолчанию');

          var adBuilder = adGroup.newAd().responsiveDisplayAdBuilder()
            .withBusinessName(bName)
            .withFinalUrl(fUrl)
            .withLongHeadline(lHead);

          var headlinesList = (task.headlines && task.headlines.length > 0) ? task.headlines : [task.headline];
          var uniqueH = getUniqueUrls_(headlinesList);
          for (var h = 0; h < Math.min(uniqueH.length, 5); h++) {
            var safeH = getSafeString_(uniqueH[h], 30, 'Заголовок ' + (h+1));
            adBuilder.addHeadline(safeH);
          }

          var descList = (task.descriptions && task.descriptions.length > 0) ? task.descriptions : [task.description];
          var uniqueD = getUniqueUrls_(descList);
          for (var d = 0; d < Math.min(uniqueD.length, 5); d++) {
            var safeD = getSafeString_(uniqueD[d], 90, 'Описание ' + (d+1));
            adBuilder.addDescription(safeD);
          }

          loadedSqAssets.forEach(function(asset) { adBuilder.addSquareMarketingImage(asset); });
          loadedRectAssets.forEach(function(asset) { adBuilder.addMarketingImage(asset); });

          if (loadedSqAssets.length > 0) {
            adBuilder.addLogoImage(loadedSqAssets[0]);
          }

          var adOperation = adBuilder.build();
          
          if (adOperation.isSuccessful()) {
             var newAd = adOperation.getResult();
             Logger.log('[CREATE_AD] ✅ Объявление собрано в группе ' + adGroup.getName() + ' (ID: ' + newAd.getId() + ')');
             groupCount++;
          } else {
             Logger.log('[CREATE_AD] ❌ Ошибка сборки в группе ' + adGroup.getName() + ': ' + adOperation.getErrors().join(', '));
          }
        }

        lines.push('📌 Создано объявление (Групп: ' + groupCount + ')');
        
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
        createdCount++;
        Logger.log('[CREATE_AD] ✅ Успешно. Pending-запись удалена: ' + task.ad_id);
      } catch(e) { 
        Logger.log('[CREATE_AD] ⚠️ Ошибка задания ' + task.ad_id + ': ' + e.message);
        lines.push('⚠️ Ошибка (' + task.ad_id.substring(0,8) + '): ' + e.message); 
        
        patchSupabase_(CONFIG.TABLE_ADS, { 
          needs_create: false, 
          error_message: e.message.substring(0, 500),
          error_at: new Date().toISOString()
        }, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      }
    });

    if (lines.length > 0) tgSend_('✅ <b>Create Ads</b>\nАкк: <code>' + myId + '</code>\nУспешно создано: ' + createdCount + '\n\n' + lines.join('\n'), CONFIG);
  }

  /* ====================== РЕЕСТРЫ И СИНХРОНИЗАЦИЯ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    Logger.log('[REGISTRY] Сохранение статистики аккаунта...');
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
    
    if (CONFIG.PROJECT_ID) {
      payload.project_id = CONFIG.PROJECT_ID;
    }
    
    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
    Logger.log('[REGISTRY] Статистика успешно отправлена.');
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    Logger.log('[SYNC_ADS] Выгрузка текущих объявлений в БД...');
    var cleanId = myId.replace(/-/g, '');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];
    var totalSynced = 0;

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
            for (var t = 0; t < topics.length; t++) { reasons.push(topics[t].getId()); }
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
      
      if (CONFIG.PROJECT_ID) {
        item.project_id = CONFIG.PROJECT_ID;
      }

      batch.push(item);

      if (batch.length >= 50) { 
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG); 
        totalSynced += batch.length;
        batch = []; 
      }
    }
    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG);
      totalSynced += batch.length;
    }
    Logger.log('[SYNC_ADS] Выгружено ' + totalSynced + ' объявлений.');
  }
  
  function syncAssetPerformance_(myId, CONFIG) {
    Logger.log('[ASSETS] Сбор статистики по ассетам за все время (ALL TIME)...');
    var cleanId = myId.replace(/-/g, '');

    var query = "SELECT asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, " +
                "ad_group_ad_asset_view.field_type, metrics.clicks, metrics.impressions, " +
                "metrics.cost_micros, metrics.conversions " +
                "FROM ad_group_ad_asset_view " +
                "WHERE metrics.impressions > 0";

    var report = AdsApp.report(query);
    var rows = report.rows();

    var assetData = {};

    while (rows.hasNext()) {
      var row = rows.next();
      var assetId = row['asset.id'];
      var type = row['asset.type'];
      var fieldType = row['ad_group_ad_asset_view.field_type'];

      var text = '';
      if (type === 'TEXT') {
        text = row['asset.text_asset.text'] || '';
      } else if (type === 'IMAGE') {
        text = row['asset.image_asset.full_size.url'] || '';
      } else {
        continue; 
      }

      var clicks = parseInt(row['metrics.clicks'], 10) || 0;
      var impressions = parseInt(row['metrics.impressions'], 10) || 0;
      var cost = (parseFloat(row['metrics.cost_micros']) || 0) / 1000000;
      var conv = parseFloat(row['metrics.conversions']) || 0;

      if (!assetData[assetId]) {
        var item = {
          account_id: cleanId,
          asset_id: assetId,
          asset_text: text,
          field_type: fieldType,
          clicks: 0,
          impressions: 0,
          cost: 0.0,
          conversions: 0.0
        };
        if (CONFIG.PROJECT_ID) {
          item.project_id = CONFIG.PROJECT_ID;
        }
        assetData[assetId] = item;
      }

      assetData[assetId].clicks += clicks;
      assetData[assetId].impressions += impressions;
      assetData[assetId].cost += cost;
      assetData[assetId].conversions += conv;
    }

    var payload = [];
    for (var key in assetData) {
       payload.push(assetData[key]);
    }

    if (payload.length === 0) {
      Logger.log('[ASSETS] Статистики по ассетам пока нет.');
      return;
    }

    var batch = [];
    var totalSynced = 0;
    for (var i = 0; i < payload.length; i++) {
      batch.push(payload[i]);
      if (batch.length >= 50) {
        apiCall_('post', '/Это логичное решение для дебага. 

Я добавил константу `SCRIPT_VERSION` в начало кода и вывод её первым же сообщением в лог. 

Здесь полная версия **v16.12**, в которую вшиты абсолютно все последние исправления (включая рабочий `mutate` для стратегии Максимум конверсий, разблокировку возраста "Неизвестно" и логирование версии). 

Копируй и заменяй целиком:

```javascript
/**
 * Google Ads Master Script (v16.12 - Target CPA Fix + Version Log)
 */

function runMain(ACCOUNT_CONFIG) {

  var SCRIPT_VERSION = 'v16.12';

  var CONFIG = {
    SUPABASE_URL: '[https://bdnppvkjpknwjlhhaarw.supabase.co](https://bdnppvkjpknwjlhhaarw.supabase.co)',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',

    PROJECT_ID:       (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PROJECT_ID) ? ACCOUNT_CONFIG.PROJECT_ID : null,

    TABLE_ACCOUNTS:   'account_registry',
    TABLE_ADS:        'display_ads_registry',

    TG_TOKEN:   '5203374800:AAGZ6T72DxmjVnqbza92O0y2SJyk2lw0Pr4',
    TG_CHAT_ID: 37742949,

    CONVERSION_NAME: 'Offline_Sale',
    
    // SMART BID UPGRADE SETTINGS
    MIN_CONVERSIONS_FOR_CPA: 10,
    TARGET_CPA:              0.1,

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
  try { ensureNewsTopicInAllGroups_(); }           catch (e) { Logger.log('[ERR][TOPICS] ' + e.message); }
  try { ensureConversionAction_(CONFIG); }         catch (e) { Logger.log('[ERR][CONV_SETUP] ' + e.message); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e.message); }
  try { autoUpgradeBiddingStrategy_(CONFIG); }     catch (e) { Logger.log('[ERR][BID_UPGRADE] ' + e.message); }
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

  /* ====================== АВТОРЕЖИМ СТРАТЕГИИ И ДЕМОГРАФИИ ====================== */

  function autoUpgradeBiddingStrategy_(CONFIG) {
    Logger.log('[BID_UPGRADE] Проверка смарт-стратегий и демографии...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var upgradedCount = 0;
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var expectedMicros = Math.round(CONFIG.TARGET_CPA * 1000000);

    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      
      // Запрашиваем через GAQL точные данные по стратегии и ставке
      var query = "SELECT campaign.bidding_strategy_type, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = " + camp.getId();
      var res = AdsApp.search(query);
      if (!res.hasNext()) continue;
      
      var row = res.next();
      var strategyType = row.campaign.bidding_strategy_type;
      var targetCpaMicros = (row.campaign.maximize_conversions && row.campaign.maximize_conversions.target_cpa_micros) ? parseInt(row.campaign.maximize_conversions.target_cpa_micros, 10) : 0;
      
      var isConversionStrategy = (strategyType === 'TARGET_CPA' || strategyType === 'MAXIMIZE_CONVERSIONS');
      var conversions = camp.getStatsFor('ALL_TIME').getConversions();
      
      var needsUpgrade = false;
      
      // Случай 1: Кампания еще на ручной ставке
      if (!isConversionStrategy && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      } 
      // Случай 2: Кампания уже переключена, но Target CPA не задан или отличается от конфига
      else if (strategyType === 'MAXIMIZE_CONVERSIONS' && targetCpaMicros !== expectedMicros && conversions >= CONFIG.MIN_CONVERSIONS_FOR_CPA) {
        needsUpgrade = true;
      }

      if (needsUpgrade) {
        Logger.log('[BID_UPGRADE] 📈 Обработка кампании "' + camp.getName() + '" (' + conversions + ' конв.). Применяем Target CPA = ' + CONFIG.TARGET_CPA);
        try {
          // ОДИН прямой запрос, который меняет И стратегию, И ставку одновременно
          AdsApp.mutate({
            campaignOperation: {
              update: {
                resourceName: 'customers/' + customerId + '/campaigns/' + camp.getId(),
                maximizeConversions: { targetCpaMicros: expectedMicros }
              },
              updateMask: 'maximizeConversions'
            }
          });
          
          upgradedCount++;
          isConversionStrategy = true; // Отмечаем для демографии ниже
          Logger.log('[BID_UPGRADE] ✅ Стратегия и ставка успешно установлены!');
        } catch (e) {
          Logger.log('[BID_UPGRADE] ❌ Ошибка переключения: ' + e.message);
        }
      }

      // Если кампания стала конверсионной, открываем возраст "Неизвестно"
      if (isConversionStrategy) {
        try {
          var qDemo = "SELECT ad_group_criterion.resource_name, ad_group.name " +
                      "FROM ad_group_criterion " +
                      "WHERE campaign.id = " + camp.getId() + " " +
                      "AND ad_group_criterion.type = 'AGE_RANGE' " +
                      "AND ad_group_criterion.negative = TRUE " +
                      "AND ad_group_criterion.age_range.type = 'AGE_RANGE_UNDETERMINED'";
          
          var searchDemo = AdsApp.search(qDemo);
          while (searchDemo.hasNext()) {
            var rowDemo = searchDemo.next();
            AdsApp.mutate({ adGroupCriterionOperation: { remove: rowDemo.ad_group_criterion.resource_name } });
            Logger.log('[DEMOGRAPHICS] 🔓 Разрешен возраст "Неизвестно" в группе: ' + rowDemo.ad_group.name);
          }
        } catch(e) {}
      }
    }
    
    if (upgradedCount === 0) {
      Logger.log('[BID_UPGRADE] Изменение ставок пока не требуется.');
    }
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
      Logger.log('[SETUP] ✅ Оффлайн-конверсия успешно создана!');
    } catch (e) {
      Logger.log('[SETUP] ❌ Ошибка автоматического создания конверсии: ' + e.message);
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
      Logger.log('[SETUP] ❌ Кампания ' + CAMPAIGN_NAME + ' не найдена.');
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
    Logger.log('[SETUP] ✅ Базовая группа успешно настроена.');
  }

  function ensureNewsTopicInAllGroups_() {
    Logger.log('[TOPICS] Проверка наличия топика News (ID 16) во всех активных группах...');
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    var addedCount = 0;
    var restoredCount = 0;

    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      try {
        var existingTopics = ag.display().topics().get();
        var found = false;
        
        while (existingTopics.hasNext()) {
          var t = existingTopics.next();
          if (t.getTopicId() === 16) {
            found = true;
            if (t.isPaused() || !t.isEnabled()) {
              t.enable();
              restoredCount++;
              Logger.log('[TOPICS] 🔄 Топик News восстановлен/включен в группе: ' + ag.getName());
            }
            break;
          }
        }

        if (!found) {
          var op = ag.display().newTopicBuilder().withTopicId(16).build();
          if (op.isSuccessful()) {
            Logger.log('[TOPICS] ➕ Топик News добавлен в группу: ' + ag.getName());
            addedCount++;
          }
        }
      } catch(e) {
        Logger.log('[TOPICS] ⚠️ Ошибка при работе с группой ' + ag.getName() + ': ' + e.message);
      }
    }
    Logger.log('[TOPICS] Готово. Создано новых: ' + addedCount + '. Восстановлено: ' + restoredCount + '.');
  }

  /* ====================== ИСКЛЮЧЕНИЕ YOUTUBE ====================== */

  function excludeYoutube_() {
    Logger.log('[YOUTUBE] Проверка принудительного исключения доменов YouTube...');
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var campCount = 0;
    var urlsToExclude = ['youtube.com', '[www.youtube.com](https://www.youtube.com)', 'm.youtube.com'];
    
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      campCount++;
      
      urlsToExclude.forEach(function(url) {
        try {
          var op = camp.display().newPlacementBuilder().withUrl(url).exclude();
          if (op.isSuccessful()) {
            Logger.log('[YOUTUBE] ✅ ' + url + ' успешно исключен на уровне кампании: ' + camp.getName());
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
    if (agCount > 0) Logger.log('[YOUTUBE] ↪️ Фолбэк: ' + url + ' исключен в ' + agCount + ' группах объявлений.');
  }

  /* ====================== GLOBAL BLACKLIST DELTA SYNC ====================== */

  function syncPlacementBlacklist_(myId, CONFIG) {
    Logger.log('[BLACKLIST] Проверка статуса синхронизации...');
    var cleanId = myId.replace(/-/g, '');
    
    var accData = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=blacklist_synced_at', null, null, CONFIG);
    var lastSync = (accData && accData.length > 0) ? accData[0].blacklist_synced_at : null;

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
      Logger.log('[BLACKLIST] Создан НОВЫЙ список исключений: ' + newListName);
      isNewList = true;
      lastSync = null; 
    }

    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (campaigns.hasNext()) {
      try { campaigns.next().addExcludedPlacementList(excludedList); } catch (e) {}
    }

    var endpoint = '/rest/v1/placement_blacklist?select=placement,created_at&limit=10000';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    if (lastSync) {
      endpoint += '&created_at=gt.' + encodeURIComponent(lastSync);
      Logger.log('[BLACKLIST] Запрос только НОВЫХ площадок (добавленных после ' + lastSync + ')');
    } else {
      Logger.log('[BLACKLIST] Запрос ВСЕЙ базы площадок (первичная загрузка списка V7)');
    }

    var data = apiCall_('get', endpoint, null, null, CONFIG);

    var GAME_CATEGORIES = ['mobileappcategory::60008', 'mobileappcategory::60506'];
    var columns = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    var addedCount = 0;
    var maxCreatedAt = lastSync;

    if (isNewList) {
      GAME_CATEGORIES.forEach(function(item) {
        upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item });
        addedCount++;
      });
    }

    if (data && data.length > 0) {
      data.forEach(function(item) {
        if (item.placement && item.placement.indexOf('youtube.com') === -1 && GAME_CATEGORIES.indexOf(item.placement) === -1) { 
          upload.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement });
          addedCount++;
          
          if (!maxCreatedAt || item.created_at > maxCreatedAt) {
            maxCreatedAt = item.created_at;
          }
        }
      });
    }

    if (addedCount > 0) {
      upload.apply();
      Logger.log('[BLACKLIST] Bulk Upload запущен. Строк отправлено: ' + addedCount);
      
      if (maxCreatedAt) {
        patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAt }, 'uid=eq.' + cleanId, CONFIG);
        Logger.log('[BLACKLIST] Время синхронизации в БД обновлено: ' + maxCreatedAt);
      }
    } else {
      Logger.log('[BLACKLIST] Нет новых площадок для загрузки.');
    }
  }

  /* ====================== OFFLINE CONVERSIONS ====================== */

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) {
      Logger.log('[CONVERSIONS] ⚠️ Пропуск: Имя конверсии не задано в CONFIG.');
      return;
    }
    
    var cleanId = myId.replace(/-/g, '');
    Logger.log('[CONVERSIONS] === СТАРТ ПРОВЕРКИ КОНВЕРСИЙ ===');
    Logger.log('[CONVERSIONS] Целевая конверсия: ' + CONFIG.CONVERSION_NAME);
    Logger.log('[CONVERSIONS] Текущий ID аккаунта (очищенный): ' + cleanId);

    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    
    var fetchUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks?uid=' + cleanId;
    Logger.log('[CONVERSIONS] GET Запрос к: ' + fetchUrl);
    
    var getRes = UrlFetchApp.fetch(fetchUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
    var resCode = getRes.getResponseCode();
    var resText = getRes.getContentText();

    Logger.log('[CONVERSIONS] Код ответа сервера: ' + resCode);
    Logger.log('[CONVERSIONS] Тело ответа (первые 200 симв.): ' + resText.substring(0, 200));

    if (resCode !== 200) {
      Logger.log('[CONVERSIONS] ❌ Ошибка сервера БД при получении конверсий.');
      return;
    }
    
    var data = JSON.parse(resText);
    if (!data || !data.conversions || data.conversions.length === 0) {
      Logger.log('[CONVERSIONS] Новых конверсий в базе не найдено.');
      return;
    }

    Logger.log('[CONVERSIONS] Всего конверсий в ответе БД: ' + data.conversions.length);

    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();

    var uploadedIds = [];

    data.conversions.forEach(function(c, index) {
      var targetAcc = (c.account_uid || '').replace(/-/g, '');
      var gclid = c.gclid || 'ПУСТО';
      var isMatch = (targetAcc === cleanId);

      Logger.log('[CONVERSIONS] [' + index + '] Проверка: GCLID=' + gclid + ', Acc=' + targetAcc + ' -> Совпадение: ' + isMatch);

      if (!isMatch || !c.gclid) return;

      var convTime = c.external_timestamp ? c.external_timestamp.replace('T', ' ') + '+0100' : 'ПУСТО';
      var payout = c.payout || 0;
      var currency = c.currency || 'USD';

      Logger.log('[CONVERSIONS] [' + index + '] ✅ Добавляем в выгрузку: Time=' + convTime + ', Value=' + payout + ' ' + currency);

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
      Logger.log('[CONVERSIONS] Запуск upload.apply(). Ожидание отправки...');
      upload.apply();
      Logger.log('[CONVERSIONS] Данные отправлены в Google Ads. Кол-во: ' + uploadedIds.length);
      
      Logger.log('[CONVERSIONS] Отправка подтверждения в БД по ID: ' + JSON.stringify(uploadedIds));
      
      var postUrl = CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks';
      var postRes = UrlFetchApp.fetch(postUrl, { 
        method: 'post', 
        headers: headers, 
        payload: JSON.stringify({ ids: uploadedIds }), 
        muteHttpExceptions: true 
      });
      Logger.log('[CONVERSIONS] Ответ БД на подтверждение: Code ' + postRes.getResponseCode() + ' | Body: ' + postRes.getContentText().substring(0, 100));
    } else {
      Logger.log('[CONVERSIONS] Нет конверсий для отправки в текущий аккаунт (' + cleanId + ').');
    }
    
    Logger.log('[CONVERSIONS] === КОНЕЦ ПРОВЕРКИ КОНВЕРСИЙ ===');
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
      if (url && unique.indexOf(url) === -1) {
        unique.push(url);
      }
    }
    return unique;
  }

  function getUniqueAssets_(assetsArray) {
    var unique = [];
    var ids = {};
    for (var i = 0; i < assetsArray.length; i++) {
      if (!assetsArray[i]) continue; // ЗАЩИТА ОТ NULL
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
    Logger.log('[CREATE_AD] Проверка заданий на создание новых объявлений...');
    var cleanId = myId.replace(/-/g, '');
    
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    
    var tasks = apiCall_('get', endpoint, null, null, CONFIG);

    if (!tasks || tasks.length === 0) {
      Logger.log('[CREATE_AD] Заданий на создание нет.');
      return;
    }

    var createdCount = 0;
    var lines = [];

    tasks.forEach(function(task) {
      try {
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
        if (!agIterator.hasNext()) {
          Logger.log('[CREATE_AD] Нет активных групп объявлений КМС.');
          return;
        }

        Logger.log('--------------------------------------------------');
        Logger.log('[CREATE_AD] НАЧАЛО ОБРАБОТКИ ЗАДАНИЯ ID: ' + task.ad_id);
        
        var ts = new Date().getTime().toString().substring(7);
        var loadedSqAssets = [];
        var loadedRectAssets = [];

        var rawSqUrls = (task.square_image_urls && task.square_image_urls.length > 0) ? task.square_image_urls : [task.square_image_url || task.img_square || '[https://example.com/1x1.jpg](https://example.com/1x1.jpg)'];
        var sqUrls = getUniqueUrls_(rawSqUrls);
        
        sqUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder()
              .withData(blob)
              .withName('Sq_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx)
              .build();
            if (op.isSuccessful()) {
              loadedSqAssets.push(op.getResult());
            } else {
              Logger.log('[CREATE_AD] ⚠️ Google отклонил квадратную картинку (' + url + '): ' + op.getErrors().join(', '));
            }
          } catch(e) {
            Logger.log('[CREATE_AD] ⚠️ Ошибка скачивания квадратной картинки (' + url + '): ' + e.message);
          }
        });

        var rawRectUrls = (task.landscape_image_urls && task.landscape_image_urls.length > 0) ? task.landscape_image_urls : [task.rectangle_image_url || task.img_rect || '[https://example.com/1.91x1.jpg](https://example.com/1.91x1.jpg)'];
        var rectUrls = getUniqueUrls_(rawRectUrls);

        rectUrls.forEach(function(url, idx) {
          try {
            var blob = UrlFetchApp.fetch(url).getBlob();
            var op = AdsApp.adAssets().newImageAssetBuilder()
              .withData(blob)
              .withName('Rect_' + (task.ad_id || 'new').substring(0, 8) + '_' + ts + '_' + idx)
              .build();
            if (op.isSuccessful()) {
              loadedRectAssets.push(op.getResult());
            } else {
              Logger.log('[CREATE_AD] ⚠️ Google отклонил горизонтальную картинку (' + url + '): ' + op.getErrors().join(', '));
            }
          } catch(e) {
            Logger.log('[CREATE_AD] ⚠️ Ошибка скачивания горизонтальной картинки (' + url + '): ' + e.message);
          }
        });

        loadedSqAssets = getUniqueAssets_(loadedSqAssets);
        loadedRectAssets = getUniqueAssets_(loadedRectAssets);

        if (loadedSqAssets.length === 0 || loadedRectAssets.length === 0) {
          throw new Error('Не удалось загрузить ни одной валидной картинки (нужна хотя бы 1 квадратная и 1 горизонтальная).');
        }

        Logger.log('[CREATE_AD] Успешно загружено: ' + loadedSqAssets.length + ' кв., ' + loadedRectAssets.length + ' гор. Синхронизация (5 сек)...');
        Utilities.sleep(5000);

        var groupCount = 0;

        while (agIterator.hasNext()) {
          var adGroup = agIterator.next();
          
          var bName = getSafeString_(task.business_name, 25, 'My Business');
          var fUrl  = String(task.final_url || '[https://example.com](https://example.com)').trim();
          if (fUrl.indexOf('http') !== 0) fUrl = 'https://' + fUrl; 
          var lHead = getSafeString_(task.long_headline, 90, 'Длинный заголовок по умолчанию');

          var adBuilder = adGroup.newAd().responsiveDisplayAdBuilder()
            .withBusinessName(bName)
            .withFinalUrl(fUrl)
            .withLongHeadline(lHead);

          var headlinesList = (task.headlines && task.headlines.length > 0) ? task.headlines : [task.headline];
          var uniqueH = getUniqueUrls_(headlinesList);
          for (var h = 0; h < Math.min(uniqueH.length, 5); h++) {
            var safeH = getSafeString_(uniqueH[h], 30, 'Заголовок ' + (h+1));
            adBuilder.addHeadline(safeH);
          }

          var descList = (task.descriptions && task.descriptions.length > 0) ? task.descriptions : [task.description];
          var uniqueD = getUniqueUrls_(descList);
          for (var d = 0; d < Math.min(uniqueD.length, 5); d++) {
            var safeD = getSafeString_(uniqueD[d], 90, 'Описание ' + (d+1));
            adBuilder.addDescription(safeD);
          }

          loadedSqAssets.forEach(function(asset) { adBuilder.addSquareMarketingImage(asset); });
          loadedRectAssets.forEach(function(asset) { adBuilder.addMarketingImage(asset); });

          if (loadedSqAssets.length > 0) {
            adBuilder.addLogoImage(loadedSqAssets[0]);
          }

          var adOperation = adBuilder.build();
          
          if (adOperation.isSuccessful()) {
             var newAd = adOperation.getResult();
             Logger.log('[CREATE_AD] ✅ Объявление собрано в группе ' + adGroup.getName() + ' (ID: ' + newAd.getId() + ')');
             groupCount++;
          } else {
             Logger.log('[CREATE_AD] ❌ Ошибка сборки в группе ' + adGroup.getName() + ': ' + adOperation.getErrors().join(', '));
          }
        }

        lines.push('📌 Создано объявление (Групп: ' + groupCount + ')');
        
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
        createdCount++;
        Logger.log('[CREATE_AD] ✅ Успешно. Pending-запись удалена: ' + task.ad_id);
      } catch(e) { 
        Logger.log('[CREATE_AD] ⚠️ Ошибка задания ' + task.ad_id + ': ' + e.message);
        lines.push('⚠️ Ошибка (' + task.ad_id.substring(0,8) + '): ' + e.message); 
        
        patchSupabase_(CONFIG.TABLE_ADS, { 
          needs_create: false, 
          error_message: e.message.substring(0, 500),
          error_at: new Date().toISOString()
        }, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      }
    });

    if (lines.length > 0) tgSend_('✅ <b>Create Ads</b>\nАкк: <code>' + myId + '</code>\nУспешно создано: ' + createdCount + '\n\n' + lines.join('\n'), CONFIG);
  }

  /* ====================== РЕЕСТРЫ И СИНХРОНИЗАЦИЯ ====================== */

  function updateAccountRegistry_(acc, CONFIG) {
    Logger.log('[REGISTRY] Сохранение статистики аккаунта...');
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
    
    if (CONFIG.PROJECT_ID) {
      payload.project_id = CONFIG.PROJECT_ID;
    }
    
    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
    Logger.log('[REGISTRY] Статистика успешно отправлена.');
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    Logger.log('[SYNC_ADS] Выгрузка текущих объявлений в БД...');
    var cleanId = myId.replace(/-/g, '');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];
    var totalSynced = 0;

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
            for (var t = 0; t < topics.length; t++) { reasons.push(topics[t].getId()); }
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
      
      if (CONFIG.PROJECT_ID) {
        item.project_id = CONFIG.PROJECT_ID;
      }

      batch.push(item);

      if (batch.length >= 50) { 
        apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG); 
        totalSynced += batch.length;
        batch = []; 
      }
    }
    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates, return=representation' }, CONFIG);
      totalSynced += batch.length;
    }
    Logger.log('[SYNC_ADS] Выгружено ' + totalSynced + ' объявлений.');
  }
  
  function syncAssetPerformance_(myId, CONFIG) {
    Logger.log('[ASSETS] Сбор статистики по ассетам за все время (ALL TIME)...');
    var cleanId = myId.replace(/-/g, '');

    var query = "SELECT asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, " +
                "ad_group_ad_asset_view.field_type, metrics.clicks, metrics.impressions, " +
                "metrics.cost_micros, metrics.conversions " +
                "FROM ad_group_ad_asset_view " +
                "WHERE metrics.impressions > 0";

    var report = AdsApp.report(query);
    var rows = report.rows();

    var assetData = {};

    while (rows.hasNext()) {
      var row = rows.next();
      var assetId = row['asset.id'];
      var type = row['asset.type'];
      var fieldType = row['ad_group_ad_asset_view.field_type'];

      var text = '';
      if (type === 'TEXT') {
        text = row['asset.text_asset.text'] || '';
      } else if (type === 'IMAGE') {
        text = row['asset.image_asset.full_size.url'] || '';
      } else {
        continue; 
      }

      var clicks = parseInt(row['metrics.clicks'], 10) || 0;
      var impressions = parseInt(row['metrics.impressions'], 10) || 0;
      var cost = (parseFloat(row['metrics.cost_micros']) || 0) / 1000000;
      var conv = parseFloat(row['metrics.conversions']) || 0;

      if (!assetData[assetId]) {
        var item = {
          account_id: cleanId,
          asset_id: assetId,
          asset_text: text,
          field_type: fieldType,
          clicks: 0,
          impressions: 0,
          cost: 0.0,
          conversions: 0.0
        };
        if (CONFIG.PROJECT_ID) {
          item.project_id = CONFIG.PROJECT_ID;
        }
        assetData[assetId] = item;
      }

      assetData[assetId].clicks += clicks;
      assetData[assetId].impressions += impressions;
      assetData[assetId].cost += cost;
      assetData[assetId].conversions += conv;
    }

    var payload = [];
    for (var key in assetData) {
       payload.push(assetData[key]);
    }

    if (payload.length === 0) {
      Logger.log('[ASSETS] Статистики по ассетам пока нет.');
      return;
    }

    var batch = [];
    var totalSynced = 0;
    for (var i = 0; i < payload.length; i++) {
      batch.push(payload[i]);
      if (batch.length >= 50) {
        apiCall_('post', '/rest/v1/asset_performance', batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
        totalSynced += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      apiCall_('post', '/rest/v1/asset_performance', batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
      totalSynced += batch.length;
    }

    Logger.log('[ASSETS] Выгружена статистика (Lifetime) по ' + totalSynced + ' уникальным ассетам.');
  }

  function syncBidsFromRegistry_(myId, CONFIG) {
    Logger.log('[BIDS] Проверка новых ставок в БД...');
    var cleanId = myId.replace(/-/g, '');
    
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId + '&select=target_cpc,needs_bid_sync';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    
    var data = apiCall_('get', endpoint, null, null, CONFIG);
    
    if (!data || data.length === 0 || !data[0].needs_bid_sync) {
      Logger.log('[BIDS] Изменение ставки не требуется.');
      return;
    }

    var target = data[0].target_cpc;
    Logger.log('[BIDS] Применяется новая ставка: ' + target);
    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (ags.hasNext()) ags.next().bidding().setCpc(target);
    
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_bid_sync: false }, 'uid=eq.' + cleanId, CONFIG);
  }

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    Logger.log('[AD_EDITS] Проверка изменений статусов/ссылок/удалений...');
    var cleanId = myId.replace(/-/g, '');
    
    var endpoint = '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_sync=eq.true';
    if (CONFIG.PROJECT_ID) {
      endpoint += '&project_id=eq.' + CONFIG.PROJECT_ID;
    }
    
    var edits = apiCall_('get', endpoint, null, null, CONFIG);
    
    if (!edits || edits.length === 0) {
      Logger.log('[AD_EDITS] Заданий на изменение нет.');
      return;
    }

    Logger.log('[AD_EDITS] Найдено заданий: ' + edits.length);
    edits.forEach(function(edit) {
      var adIterator = AdsApp.ads().withCondition('Id = ' + edit.ad_id).get();
      
      if (!adIterator.hasNext()) {
        if (edit.target_status === 'REMOVED') {
          Logger.log('[AD_EDITS] 🗑️ Объявление ' + edit.ad_id + ' не найдено в аккаунте. Очищаем БД.');
          deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG);
        } else {
          Logger.log('[AD_EDITS] Объявление ' + edit.ad_id + ' не найдено. Сброс флага needs_sync.');
          patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false, edit_final_url: null, target_status: null }, 'ad_id=eq.' + edit.ad_id, CONFIG);
        }
        return;
      }
      
      var ad = adIterator.next();

      if (edit.target_status === 'REMOVED') {
        ad.remove();
        Logger.log('[AD_EDITS] 🗑️ Объявление ' + edit.ad_id + ' физически удалено.');
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG);
        return;
      }

      if (edit.target_status === 'ENABLED') { ad.enable(); Logger.log('[AD_EDITS] Включено: ' + edit.ad_id); }
      if (edit.target_status === 'PAUSED')  { ad.pause();  Logger.log('[AD_EDITS] Остановлено: ' + edit.ad_id); }
      if (edit.edit_final_url) { ad.urls().setFinalUrl(edit.edit_final_url); Logger.log('[AD_EDITS] Ссылка обновлена: ' + edit.ad_id); }

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
    var text = res.getContentText();
    
    if (code !== 200 && code !== 201 && code !== 204) {
      Logger.log('[API_ERROR] Body: ' + text);
    }
    return (method === 'get' && code === 200 && text.length > 0) ? JSON.parse(text) : null;
  }

  function patchSupabase_(table, data, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var endpoint = '/rest/v1/' + table + '?' + query;
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, {
      method: 'patch', contentType: 'application/json', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key },
      payload: JSON.stringify(data), muteHttpExceptions: true
    });
  }

  function deleteSupabase_(table, query, CONFIG) {
    var key = CONFIG.SUPABASE_KEY.replace(/\s/g, '');
    var endpoint = '/rest/v1/' + table + '?' + query;
    UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, {
      method: 'delete', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }, muteHttpExceptions: true
    });
  }

  function tgSend_(txt, CONFIG) {
    try { UrlFetchApp.fetch('[https://api.telegram.org/bot](https://api.telegram.org/bot)' + CONFIG.TG_TOKEN + '/sendMessage', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: txt, parse_mode: 'HTML' }), muteHttpExceptions: true }); } catch(e) {}
  }

  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }

} // конец runMain()
