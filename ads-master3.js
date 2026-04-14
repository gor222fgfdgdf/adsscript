/**
 * Google Ads Master Script (v16.48 - Allow Unknown Age)
 */

function runMain(ACCOUNT_CONFIG) {

  var SCRIPT_VERSION = 'v16.48';

  var CONFIG = {
    SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',
    PROJECT_ID: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.PROJECT_ID) ? ACCOUNT_CONFIG.PROJECT_ID : null,
    GMAIL_DATA: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.GMAIL_DATA) ? ACCOUNT_CONFIG.GMAIL_DATA : { doc: null, payment: null, pause: null },
    TABLE_ACCOUNTS: 'account_registry',
    TABLE_ADS: 'display_ads_registry',
    CONVERSION_NAME: 'Offline_Sale',
    SAFETY_LIMIT: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.SAFETY_LIMIT != null) ? ACCOUNT_CONFIG.SAFETY_LIMIT : 45,
    EXTRA_LIMIT: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EXTRA_LIMIT != null) ? ACCOUNT_CONFIG.EXTRA_LIMIT : 0,
    EMAIL: (ACCOUNT_CONFIG && ACCOUNT_CONFIG.EMAIL) ? ACCOUNT_CONFIG.EMAIL : ''
  };

  var acc = AdsApp.currentAccount();
  var myId = acc.getCustomerId();

  Logger.log('[SYSTEM] Версия скрипта: ' + SCRIPT_VERSION);
  logDivider_('START');

  try { checkSafetyLimitsStrict_(acc, CONFIG); } catch (e) {}
  try { maybeCreateDefaultAdGroup_(); } catch (e) {}
  try { ensureConversionAction_(CONFIG); } catch (e) {}
  try { revertCampaignsToCpc_(); } catch (e) {}
  
  try { enableUnknownAgeInAllGroups_(); } catch (e) {}
  try { excludeTargetAgesInAllGroups_(); } catch (e) {}
  
  try { syncTargetingStrategy_(myId, CONFIG); } catch (e) {}
  try { syncBidsFromRegistry_(myId, CONFIG); } catch (e) {}
  try { syncUnpauseFromRegistry_(myId, CONFIG); } catch (e) {}
  try { syncAdEditsFromRegistry_(myId, CONFIG); } catch (e) {}
  try { updateAccountRegistry_(acc, CONFIG); } catch (e) {}
  try { syncAdsToRegistry_(myId, CONFIG); } catch (e) {}
  try { syncAssetPerformance_(myId, CONFIG); } catch (e) {}
  try { createAdFromRegistry_(myId, CONFIG); } catch (e) {}
  try { uploadConversionsFromEdge_(myId, CONFIG); } catch (e) {}
  try { excludeYoutube_(); } catch (e) {}

  logDivider_('END');

  function updateAccountRegistry_(acc, CONFIG) {
    var cleanId = acc.getCustomerId().replace(/-/g, '');
    var activeBid = 0; var balance = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignName = "Display-1"').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    var payload = {
      uid: cleanId, 
      name: acc.getName(), 
      email: CONFIG.EMAIL,
      today_cost: acc.getStatsFor('TODAY').getCost(), 
      all_cost: acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid, 
      balance: balance, 
      updated_at: new Date().toISOString(),
      gmail_doc_verification: CONFIG.GMAIL_DATA.doc,
      gmail_payment_verification: CONFIG.GMAIL_DATA.payment,
      gmail_pause_status: CONFIG.GMAIL_DATA.pause
    };
    if (CONFIG.PROJECT_ID) payload.project_id = CONFIG.PROJECT_ID;
    apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS, payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncTargetingStrategy_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var accData = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId, null, null, CONFIG);
    var accType = (accData && accData.length > 0) ? accData[0].account_type : null;
    var lastSync = (accData && accData.length > 0) ? accData[0].blacklist_synced_at : null;

    if (accType === 'whitelist') {
      var topics = AdsApp.display().topics().get();
      while (topics.hasNext()) topics.next().remove();
      var existingCount = 0;
      try {
        var query = "SELECT ad_group_criterion.criterion_id FROM ad_group_criterion WHERE ad_group.status = 'ENABLED' AND ad_group_criterion.type IN ('PLACEMENT', 'MOBILE_APP_CATEGORY', 'MOBILE_APPLICATION') AND ad_group_criterion.negative = FALSE";
        var res = AdsApp.search(query);
        while(res.hasNext()) { res.next(); existingCount++; }
      } catch(e) {}
      if (existingCount === 0) lastSync = null;
      var endpoint = '/rest/v1/placement_whitelist?select=placement,created_at&limit=10000';
      if (lastSync) endpoint += '&created_at=gt.' + encodeURIComponent(lastSync);
      var data = apiCall_('get', endpoint, null, null, CONFIG);
      if (data && data.length > 0) {
        var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
        var targetGroups = [];
        while (ags.hasNext()) { targetGroups.push(ags.next()); }
        var addedCount = 0; var maxCreatedAt = lastSync;
        data.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1) {
            targetGroups.forEach(function(ag) {
              try {
                if (item.placement.indexOf('mobileappcategory::') === 0) {
                  var catId = item.placement.split('::')[1];
                  AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/' + cleanId + '/adGroups/' + ag.getId(), status: 'ENABLED', mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategories/' + catId } } } });
                  addedCount++;
                } else if (item.placement.indexOf('mobileapp::') === 0) {
                  var appData = item.placement.split('::')[1];
                  var success = false;
                  try {
                    var op = ag.display().newMobileAppBuilder().withAppId(appData).build();
                    if (op.isSuccessful()) success = true;
                  } catch(e) {}
                  if (!success) {
                    try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/' + cleanId + '/adGroups/' + ag.getId(), status: 'ENABLED', mobileApp: { appId: appData } } } }); success = true; } catch(e) {}
                  }
                  if (success) addedCount++;
                } else {
                  var op = ag.display().newPlacementBuilder().withUrl(item.placement).build();
                  if (op.isSuccessful()) addedCount++;
                }
              } catch(e) {}
            });
            if (!maxCreatedAt || item.created_at > maxCreatedAt) maxCreatedAt = item.created_at;
          }
        });
        if (addedCount > 0) patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAt }, 'uid=eq.' + cleanId, CONFIG);
      }
    } else {
      var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
      while (adGroups.hasNext()) {
        var ag = adGroups.next();
        try {
          var existingTopics = ag.display().topics().get();
          var found = false;
          while (existingTopics.hasNext()) { if (existingTopics.next().getTopicId() === 16) { found = true; break; } }
          if (!found) ag.display().newTopicBuilder().withTopicId(16).build();
        } catch(e) {}
      }
      var newListName = 'Global Supabase Blacklist V7';
      var excludedList;
      var listIterator = AdsApp.excludedPlacementLists().withCondition("Name = '" + newListName + "'").get();
      if (listIterator.hasNext()) { excludedList = listIterator.next(); } 
      else { excludedList = AdsApp.newExcludedPlacementListBuilder().withName(newListName).build().getResult(); lastSync = null; }
      var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
      while (campaigns.hasNext()) { try { campaigns.next().addExcludedPlacementList(excludedList); } catch (e) {} }
      var endpointBl = '/rest/v1/placement_blacklist?select=placement,created_at&limit=10000';
      if (CONFIG.PROJECT_ID) endpointBl += '&project_id=eq.' + CONFIG.PROJECT_ID;
      if (lastSync) endpointBl += '&created_at=gt.' + encodeURIComponent(lastSync);
      var dataBl = apiCall_('get', endpointBl, null, null, CONFIG);
      var uploadBl = AdsApp.bulkUploads().newCsvUpload(['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion']);
      var addedCountBl = 0; var maxCreatedAtBl = lastSync;
      if (dataBl && dataBl.length > 0) {
        dataBl.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1) {
            uploadBl.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Customer ID': '', 'Placement Exclusion List ID': '', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement });
            addedCountBl++;
            if (!maxCreatedAtBl || item.created_at > maxCreatedAtBl) maxCreatedAtBl = item.created_at;
          }
        });
      }
      if (addedCountBl > 0) { uploadBl.apply(); patchSupabase_(CONFIG.TABLE_ACCOUNTS, { blacklist_synced_at: maxCreatedAtBl }, 'uid=eq.' + cleanId, CONFIG); }
    }
  }

  function revertCampaignsToCpc_() {
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      if (camp.bidding().getStrategyType() !== 'MANUAL_CPC') { try { camp.bidding().setStrategy('MANUAL_CPC'); } catch (e) {} }
    }
  }

  function enableUnknownAgeInAllGroups_() {
    try {
      var query = "SELECT ad_group_criterion.resource_name " +
                  "FROM ad_group_criterion " +
                  "WHERE ad_group.status = 'ENABLED' " +
                  "AND ad_group_criterion.type = 'AGE_RANGE' " +
                  "AND ad_group_criterion.negative = TRUE " +
                  "AND ad_group_criterion.age_range.type = 'AGE_RANGE_UNDETERMINED'";
      var search = AdsApp.search(query);
      while (search.hasNext()) {
        AdsApp.mutate({ adGroupCriterionOperation: { remove: search.next().adGroupCriterion.resourceName } });
      }
    } catch(e) {}
  }

  function excludeTargetAgesInAllGroups_() {
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    while (adGroups.hasNext()) {
      var ag = adGroups.next();
      var ages = ['AGE_RANGE_45_54'];
      for (var i = 0; i < ages.length; i++) {
        try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/' + customerId + '/adGroups/' + ag.getId(), negative: true, ageRange: { type: ages[i] } } } }); } catch(e) {}
      }
    }
  }

  function syncUnpauseFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var data = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId, null, null, CONFIG);
    if (!data || data.length === 0 || !data[0].needs_unpause_groups) return; 
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (campaigns.hasNext()) {
      var pausedAgs = campaigns.next().adGroups().withCondition('Status = PAUSED').get();
      while (pausedAgs.hasNext()) pausedAgs.next().enable();
    }
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_unpause_groups: false }, 'uid=eq.' + cleanId, CONFIG);
  }

  function ensureConversionAction_(CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;
    if (AdsApp.search("SELECT conversion_action.id FROM conversion_action WHERE conversion_action.name = '" + CONFIG.CONVERSION_NAME + "'").hasNext()) return;
    try { AdsApp.mutate({ conversionActionOperation: { create: { name: CONFIG.CONVERSION_NAME, type: 'UPLOAD_CLICKS', category: 'PURCHASE', status: 'ENABLED' } } }); } catch (e) {}
  }

  function maybeCreateDefaultAdGroup_() {
    var CAMPAIGNS = ['Display-1', 'Display-2'];
    var customerId = AdsApp.currentAccount().getCustomerId().replace(/-/g, '');
    var ages = [ 'AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44' ];

    for (var i = 0; i < CAMPAIGNS.length; i++) {
      var cName = CAMPAIGNS[i];
      var campIter = AdsApp.campaigns().withCondition('Name = "' + cName + '"').withCondition('Status != REMOVED').get();
      if (!campIter.hasNext()) continue;
      
      var campaign = campIter.next();
      var agCheck = campaign.adGroups().withCondition("Name = 'Topic_All'").withCondition("Status != REMOVED").get();
      if (agCheck.hasNext()) continue;

      var CPC_BID = (cName === 'Display-2') ? 0.01 : 0.02;
      var adGroupResult = campaign.newAdGroupBuilder().withName('Topic_All').withCpc(CPC_BID).build();
      if (!adGroupResult.isSuccessful()) continue;

      var adGroup = adGroupResult.getResult();
      var adGroupResourceName = 'customers/' + customerId + '/adGroups/' + adGroup.getId();
      for (var a = 0; a < ages.length; a++) {
        try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: adGroupResourceName, negative: true, ageRange: { type: ages[a] } } } }); } catch(e) {}
      }
    }
  }

  function excludeYoutube_() {
    var campaigns = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    var urls = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
    while (campaigns.hasNext()) {
      var camp = campaigns.next();
      urls.forEach(function(url) {
        try { if (!camp.display().newPlacementBuilder().withUrl(url).exclude().isSuccessful()) {
          var ags = camp.adGroups().withCondition('Status = ENABLED').get();
          while (ags.hasNext()) { try { ags.next().display().newPlacementBuilder().withUrl(url).exclude(); } catch(e) {} }
        }} catch (e) {}
      });
    }
  }

  function uploadConversionsFromEdge_(myId, CONFIG) {
    if (!CONFIG.CONVERSION_NAME) return;
    var cleanId = myId.replace(/-/g, '');
    var headers = { 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    var getRes = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks?uid=' + cleanId, { method: 'get', headers: headers, muteHttpExceptions: true });
    if (getRes.getResponseCode() !== 200) return;
    var data = JSON.parse(getRes.getContentText());
    if (!data || !data.conversions || data.conversions.length === 0) return;
    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();
    var uploadedIds = [];
    data.conversions.forEach(function(c) {
      var targetAcc = (c.account_uid || '').replace(/-/g, '');
      if (targetAcc !== cleanId || !c.gclid) return;
      upload.append({ 'Google Click ID': c.gclid, 'Conversion Name': CONFIG.CONVERSION_NAME, 'Conversion Time': c.external_timestamp ? c.external_timestamp.replace('T', ' ') + '+0100' : '', 'Conversion Value': c.payout || 0, 'Conversion Currency': c.currency || 'USD' });
      uploadedIds.push(c.id);
    });
    if (uploadedIds.length > 0) { upload.apply(); UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/functions/v1/fetch-postbacks', { method: 'post', headers: headers, payload: JSON.stringify({ ids: uploadedIds }), muteHttpExceptions: true }); }
  }

  function createAdFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var tasks = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_create=eq.true&limit=5', null, null, CONFIG);
    if (!tasks || tasks.length === 0) return;

    tasks.forEach(function(task) {
      try {
        var targetCamp = task.campaign_name || 'Display-1';
        var agIterator = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignName = "' + targetCamp + '"').get();
        if (!agIterator.hasNext()) throw new Error('No active groups in ' + targetCamp);

        var ts = new Date().getTime().toString().substring(7);
        var loadedSq = []; var loadedRect = [];
        var sqUrls = getUniqueUrls_((task.square_image_urls && task.square_image_urls.length > 0) ? task.square_image_urls : [task.square_image_url || task.img_square]);
        sqUrls.forEach(function(url, idx) { try { var op = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(url).getBlob()).withName('Sq_' + ts + '_' + idx).build(); if (op.isSuccessful()) loadedSq.push(op.getResult()); } catch(e) {} });
        var rectUrls = getUniqueUrls_((task.landscape_image_urls && task.landscape_image_urls.length > 0) ? task.landscape_image_urls : [task.rectangle_image_url || task.img_rect]);
        rectUrls.forEach(function(url, idx) { try { var op = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(url).getBlob()).withName('Rect_' + ts + '_' + idx).build(); if (op.isSuccessful()) loadedRect.push(op.getResult()); } catch(e) {} });
        if (loadedSq.length === 0 || loadedRect.length === 0) throw new Error('Images fail');
        Utilities.sleep(5000);

        while (agIterator.hasNext()) {
          var adGroup = agIterator.next();
          var adBuilder = adGroup.newAd().responsiveDisplayAdBuilder().withBusinessName(getSafeString_(task.business_name, 25, 'My Business')).withFinalUrl(task.final_url).withLongHeadline(getSafeString_(task.long_headline, 90, 'Headline'));
          var hList = getUniqueUrls_((task.headlines && task.headlines.length > 0) ? task.headlines : [task.headline]);
          for (var h = 0; h < Math.min(hList.length, 5); h++) adBuilder.addHeadline(getSafeString_(hList[h], 30, 'H' + h));
          var dList = getUniqueUrls_((task.descriptions && task.descriptions.length > 0) ? task.descriptions : [task.description]);
          for (var d = 0; d < Math.min(dList.length, 5); d++) adBuilder.addDescription(getSafeString_(dList[d], 90, 'D' + d));
          loadedSq.forEach(function(asset) { adBuilder.addSquareMarketingImage(asset); });
          loadedRect.forEach(function(asset) { adBuilder.addMarketingImage(asset); });
          if (loadedSq.length > 0) adBuilder.addLogoImage(loadedSq[0]);
          adBuilder.build();
        }
        deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG);
      } catch(e) { patchSupabase_(CONFIG.TABLE_ADS, { needs_create: false, error_message: e.message.substring(0, 500) }, 'ad_id=eq.' + encodeURIComponent(task.ad_id), CONFIG); }
    });
  }

  function syncAdsToRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get();
    var batch = [];
    while (ads.hasNext()) {
      var ad = ads.next(); var stats = ad.getStatsFor('TODAY');
      batch.push({ ad_id: ad.getId().toString(), account_id: cleanId, campaign_name: ad.getCampaign().getName(), type: ad.getType(), final_url: ad.urls().getFinalUrl() || '', clicks: stats.getClicks(), cost: stats.getCost(), status: ad.isPaused() ? 'PAUSED' : 'ENABLED', updated_at: new Date().toISOString() });
      if (batch.length >= 50) { apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG); batch = []; }
    }
    if (batch.length > 0) apiCall_('post', '/rest/v1/' + CONFIG.TABLE_ADS, batch, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncAssetPerformance_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var report = AdsApp.report("SELECT asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, ad_group_ad_asset_view.field_type, metrics.clicks, metrics.impressions, metrics.cost_micros FROM ad_group_ad_asset_view WHERE metrics.impressions > 0");
    var rows = report.rows(); var assetData = {};
    while (rows.hasNext()) {
      var row = rows.next(); var id = row['asset.id'];
      if (!assetData[id]) assetData[id] = { account_id: cleanId, asset_id: id, asset_text: row['asset.text_asset.text'] || row['asset.image_asset.full_size.url'], field_type: row['ad_group_ad_asset_view.field_type'], clicks: 0, impressions: 0, cost: 0 };
      assetData[id].clicks += parseInt(row['metrics.clicks']); assetData[id].impressions += parseInt(row['metrics.impressions']); assetData[id].cost += parseFloat(row['metrics.cost_micros'])/1000000;
    }
    var payload = []; for (var k in assetData) payload.push(assetData[k]);
    if (payload.length > 0) apiCall_('post', '/rest/v1/asset_performance', payload, { 'Prefer': 'resolution=merge-duplicates' }, CONFIG);
  }

  function syncBidsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var data = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ACCOUNTS + '?uid=eq.' + cleanId, null, null, CONFIG);
    if (!data || data.length === 0 || !data[0].needs_bid_sync) return;

    var target1 = data[0].target_cpc || 0.05;
    var target2 = data[0].warmup_cpc || 0.01;

    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (ags.hasNext()) {
      var ag = ags.next();
      if (ag.getCampaign().bidding().getStrategyType() === 'MANUAL_CPC') {
        var cName = ag.getCampaign().getName();
        if (cName === 'Display-1') ag.bidding().setCpc(target1);
        else if (cName === 'Display-2') ag.bidding().setCpc(target2);
      }
    }
    patchSupabase_(CONFIG.TABLE_ACCOUNTS, { needs_bid_sync: false }, 'uid=eq.' + cleanId, CONFIG);
  }

  function syncAdEditsFromRegistry_(myId, CONFIG) {
    var cleanId = myId.replace(/-/g, '');
    var edits = apiCall_('get', '/rest/v1/' + CONFIG.TABLE_ADS + '?account_id=eq.' + cleanId + '&needs_sync=eq.true', null, null, CONFIG);
    if (!edits || edits.length === 0) return;
    edits.forEach(function(edit) {
      var it = AdsApp.ads().withCondition('Id = ' + edit.ad_id).get();
      if (it.hasNext()) {
        var ad = it.next();
        if (edit.target_status === 'REMOVED') { ad.remove(); deleteSupabase_(CONFIG.TABLE_ADS, 'ad_id=eq.' + edit.ad_id, CONFIG); }
        else {
          if (edit.target_status === 'ENABLED') ad.enable(); else if (edit.target_status === 'PAUSED') ad.pause();
          if (edit.edit_final_url) ad.urls().setFinalUrl(edit.edit_final_url);
          patchSupabase_(CONFIG.TABLE_ADS, { needs_sync: false }, 'ad_id=eq.' + edit.ad_id, CONFIG);
        }
      }
    });
  }

  function checkSafetyLimitsStrict_(acc, CONFIG) {
    var today = acc.getStatsFor('TODAY').getCost();
    var limit = CONFIG.SAFETY_LIMIT + CONFIG.EXTRA_LIMIT;
    if (today >= limit) {
      var camps = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (camps.hasNext()) { var c = camps.next(); var ads = c.ads().get(); while (ads.hasNext()) ads.next().remove(); c.pause(); }
    }
  }

  function apiCall_(method, endpoint, payload, headersExtra, CONFIG) {
    var headers = { 'apikey': CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Authorization': 'Bearer ' + CONFIG.SUPABASE_KEY.replace(/\s/g, ''), 'Content-Type': 'application/json' };
    if (headersExtra) for (var h in headersExtra) headers[h] = headersExtra[h];
    var res = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + endpoint, { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
    return (method === 'get' && res.getResponseCode() === 200) ? JSON.parse(res.getContentText()) : null;
  }

  function patchSupabase_(table, data, query, CONFIG) { apiCall_('patch', '/rest/v1/' + table + '?' + query, data, null, CONFIG); }
  function deleteSupabase_(table, query, CONFIG) { apiCall_('delete', '/rest/v1/' + table + '?' + query, null, null, CONFIG); }
  function logDivider_(l) { Logger.log('=== ' + l + ' ==='); }
  function getSafeString_(v, l, f) { return (v && String(v).trim()) ? String(v).substring(0, l) : f; }
  function getUniqueUrls_(a) { var u = []; if (!a) return u; for (var i=0; i<a.length; i++) { var x = (a[i]||'').trim(); if (x && u.indexOf(x)===-1) u.push(x); } return u; }

} // runMain end
