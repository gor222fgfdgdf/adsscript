/**
 * Google Ads Master Script (v15.60 - Optimized Conversion Fetching)
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

  try { checkSafetyLimitsStrict_(acc, CONFIG); }   catch (e) { Logger.log('[ERR][SAFETY] ' + e.message); }
  
  try { maybeCreateDefaultAdGroup_(); }            catch (e) { Logger.log('[ERR][SETUP_AG] ' + e.message); }
  try { removeAllTopics_(); }                      catch (e) { Logger.log('[ERR][TOPIC_CLEANUP] ' + e.message); }
  try { ensureConversionAction_(CONFIG); }         catch (e) { Logger.log('[ERR][CONV_SETUP] ' + e.message); }

  try { syncBidsFromRegistry_(myId, CONFIG); }     catch (e) { Logger.log('[ERR][BIDS] ' + e.message); }
  try { syncAdEditsFromRegistry_(myId, CONFIG); }  catch (e) { Logger.log('[ERR][AD_EDITS] ' + e.message); }
  
  try { updateAccountRegistry_(acc, CONFIG); }     catch (e) { Logger.log('[ERR][REGISTRY] ' + e.message); }
  try { syncAdsToRegistry_(myId, CONFIG); }        catch (e) { Logger.log('[ERR][SYNC_ADS] ' + e.message); }

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

  /* ====================== АВТОСОЗДАНИЕ ГРУППЫ И ОЧИСТКА ТЕМ ====================== */

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
    Logger.log('[SETUP] ✅ Базовая группа (широкая) успешно настроена.');
  }

  function removeAllTopics_() {
    Logger.log('[TOPICS] Удаление всех тем таргетинга для перехода на широкую аудиторию...');
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    var removedCount = 0;

    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      try {
        var topics = ag.display().topics().get();
        while (topics.hasNext()) {
          var t = topics.next();
          t.remove();
          removedCount++;
        }
      } catch(e) {
        Logger.log('[TOPICS] ⚠️ Ошибка при очистке тем в группе ' + ag.getName() + ': ' + e.message);
      }
    }
    
    if (removedCount > 0) {
      Logger.log('[TOPICS] ✅ Успешно удалено тем таргетинга: ' + removedCount);
    } else {
      Logger.log('[TOPICS] Темы таргетинга не найдены (уже широкая аудитория).');
    }
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

  /* ====================== GLOBAL BLACKLIST ====================== */

  function syncPlacementBlacklist_(myId, CONFIG) {
    Logger.log('[BLACKLIST] Получение глобального списка минус-площадок...');
    var endpoint = '/rest/v1/placement_blacklist?select=placement&limit=10000';
    var data = apiCall_('get', endpoint, null, null, CONFIG);

    var listName = 'Global Supabase Blacklist V2'; 
    var excludedList;

    var listIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + listName + "'").get();
    if (listIterator.hasNext()) {
      excludedList = listIterator.next();
    } else {
      excludedList = AdsApp.newExcludedPlacementListBuilder().withName(listName).build().getResult();
      Logger.log('[BLACKLIST] Создан новый список исключений: ' + listName);
    }

    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var campCount = 0;
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      if (excludedList) {
        try { camp.addExcludedPlacementList(excludedList); campCount++; } catch (e) {}
      }
    }
    Logger.log('[BLACKLIST] Общий список привязан к ' + campCount + ' активным КМС кампаниям.');

    var GAME_CATEGORIES = [
      'mobileappcategory::60008',
      'mobileappcategory::60506'
    ];

    var columns = ['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion'];
    var upload = AdsApp.bulkUploads().newCsvUpload(columns);
    var addedCount = 0;

    GAME_CATEGORIES.forEach(function(item) {
      upload.append({
        'Row Type': 'Negative Placement',
        'Action': 'Add',
        'Customer ID': '',
        'Placement Exclusion List ID': '',
        'Placement Exclusion List Name': listName,
        'Placement Exclusion': item
      });
      addedCount++;
    });

    if (data && data.length > 0) {
      data.forEach(function(item) {
        if (item.placement && item.placement.indexOf('youtube.com') === -1 && GAME_CATEGORIES.indexOf(item.placement) === -1) { 
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
    }

    if (addedCount > 0) {
      upload.apply();
      Logger.log('[BLACKLIST] Bulk Upload запущен. Игровых категорий и площадок отправлено: ' + addedCount);
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
    
    // ДОБАВЛЕН ПАРАМЕТР ?uid= ДЛЯ ФИЛЬТРАЦИИ НА УРОВНЕ EDGE FUNCTION
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
      
      // POST запрос уходит на базовый URL без query параметров
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
    var tasks = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5', null, null, CONFIG);

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
