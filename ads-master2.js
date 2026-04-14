/**
 * Google Ads Master Script (v16.55 - Wipe All Ads)
 */
function runMain(cfg) {
  var SCRIPT_VERSION = 'v16.55';
  var acc = AdsApp.currentAccount();
  var cleanId = acc.getCustomerId().replace(/-/g, '');
  
  var ctx = {
    acc: acc,
    myId: acc.getCustomerId(),
    cleanId: cleanId,
    config: {
      SUPABASE_URL: 'https://bdnppvkjpknwjlhhaarw.supabase.co',
      SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkbnBwdmtqcGtud2psaGhhYXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxOTE2MDEsImV4cCI6MjA4Mzc2NzYwMX0.-Xs7L7prn4RjIXMy4Ya3DrcLh8q3R-7m2Dd_GbQk-fI',
      PROJECT_ID: cfg.PROJECT_ID || null,
      ACCOUNT_STATUS: cfg.ACCOUNT_STATUS || 'ACTIVE',
      CONVERSION_NAME: 'Offline_Sale',
      SAFETY_LIMIT: cfg.SAFETY_LIMIT != null ? cfg.SAFETY_LIMIT : 45,
      EXTRA_LIMIT: cfg.EXTRA_LIMIT != null ? cfg.EXTRA_LIMIT : 0,
      EMAIL: cfg.EMAIL || ''
    }
  };

  var accData = api('get', 'account_registry?uid=eq.' + cleanId + '&select=account_status', null, ctx);
  ctx.status = (accData && accData.length > 0 && accData[0].account_status) ? accData[0].account_status : ctx.config.ACCOUNT_STATUS;
  ctx.targetCamp = (ctx.status === 'WARMUP') ? 'Display-2' : 'Display-1';

  var modules = [
    deleteAllAds_,
    checkSafetyLimitsStrict_, maybeCreateDefaultAdGroup_, ensureConversionAction_,
    revertCampaignsToCpc_, syncAgeDemographics_, syncTargetingStrategy_,
    syncBidsFromRegistry_, syncUnpauseFromRegistry_, syncAdEditsFromRegistry_,
    updateAccountRegistry_, syncAdsToRegistry_, syncAssetPerformance_,
    createAdFromRegistry_, uploadConversionsFromEdge_, excludeYoutube_
  ];

  modules.forEach(function(mod) {
    try { mod(ctx); } catch (e) {}
  });

  function deleteAllAds_(ctx) {
    var ads = AdsApp.ads().withCondition('Status != REMOVED').get();
    while (ads.hasNext()) {
      ads.next().remove();
    }
  }

  function updateAccountRegistry_(ctx) {
    var activeBid = 0, balance = 0;
    try {
      var ag = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignName = "' + ctx.targetCamp + '"').withLimit(1).get();
      if (ag.hasNext()) activeBid = ag.next().bidding().getCpc();
      var bo = AdsApp.budgetOrders().get();
      if (bo.hasNext()) balance = bo.next().getSpendingLimit() - ctx.acc.getStatsFor('ALL_TIME').getCost();
    } catch(e) {}

    var payload = {
      uid: ctx.cleanId, name: ctx.acc.getName(), email: ctx.config.EMAIL,
      today_cost: ctx.acc.getStatsFor('TODAY').getCost(), all_cost: ctx.acc.getStatsFor('ALL_TIME').getCost(),
      current_cpc: activeBid, balance: balance, updated_at: new Date().toISOString(),
      account_status: ctx.status
    };
    if (ctx.config.PROJECT_ID) payload.project_id = ctx.config.PROJECT_ID;
    api('post', 'account_registry', payload, ctx, 'resolution=merge-duplicates');
  }

  function syncTargetingStrategy_(ctx) {
    var accData = api('get', 'account_registry?uid=eq.' + ctx.cleanId, null, ctx);
    var accType = accData && accData.length ? accData[0].account_type : null;
    var lastSync = accData && accData.length ? accData[0].blacklist_synced_at : null;

    if (accType === 'whitelist') {
      var topics = AdsApp.display().topics().get();
      while (topics.hasNext()) topics.next().remove();
      if (!AdsApp.search("SELECT ad_group_criterion.criterion_id FROM ad_group_criterion WHERE ad_group.status = 'ENABLED' AND ad_group_criterion.type IN ('PLACEMENT', 'MOBILE_APP_CATEGORY', 'MOBILE_APPLICATION') AND ad_group_criterion.negative = FALSE").hasNext()) lastSync = null;
      var data = api('get', 'placement_whitelist?select=placement,created_at&limit=10000' + (lastSync ? '&created_at=gt.' + encodeURIComponent(lastSync) : ''), null, ctx);
      if (data && data.length) {
        var ags = AdsApp.adGroups().withCondition('Status = ENABLED').get(), targetGroups = [];
        while (ags.hasNext()) targetGroups.push(ags.next());
        var maxSync = lastSync;
        data.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1) {
            targetGroups.forEach(function(ag) {
              try {
                if (item.placement.indexOf('mobileappcategory::') === 0) AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/'+ctx.cleanId+'/adGroups/'+ag.getId(), status: 'ENABLED', mobileAppCategory: { mobileAppCategoryConstant: 'mobileAppCategories/'+item.placement.split('::')[1] } } } });
                else if (item.placement.indexOf('mobileapp::') === 0) AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/'+ctx.cleanId+'/adGroups/'+ag.getId(), status: 'ENABLED', mobileApp: { appId: item.placement.split('::')[1] } } } });
                else ag.display().newPlacementBuilder().withUrl(item.placement).build();
              } catch(e) {}
            });
            if (!maxSync || item.created_at > maxSync) maxSync = item.created_at;
          }
        });
        api('patch', 'account_registry?uid=eq.' + ctx.cleanId, { blacklist_synced_at: maxSync }, ctx);
      }
    } else {
      var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
      while (adGroups.hasNext()) {
        var ag = adGroups.next(), existingTopics = ag.display().topics().get(), found = false;
        while (existingTopics.hasNext()) if (existingTopics.next().getTopicId() === 16) { found = true; break; }
        if (!found) try { ag.display().newTopicBuilder().withTopicId(16).build(); } catch(e){}
      }
      var newListName = 'Global Supabase Blacklist V7', it = AdsApp.excludedPlacementLists().withCondition("Name = '" + newListName + "'").get(), excludedList;
      if (it.hasNext()) excludedList = it.next(); else { excludedList = AdsApp.newExcludedPlacementListBuilder().withName(newListName).build().getResult(); lastSync = null; }
      var camps = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
      while (camps.hasNext()) try { camps.next().addExcludedPlacementList(excludedList); } catch (e) {}
      var endpointBl = 'placement_blacklist?select=placement,created_at&limit=10000';
      if (ctx.config.PROJECT_ID) endpointBl += '&project_id=eq.' + ctx.config.PROJECT_ID;
      if (lastSync) endpointBl += '&created_at=gt.' + encodeURIComponent(lastSync);
      var dataBl = api('get', endpointBl, null, ctx), maxSyncBl = lastSync, uploadBl = AdsApp.bulkUploads().newCsvUpload(['Row Type', 'Action', 'Customer ID', 'Placement Exclusion List ID', 'Placement Exclusion List Name', 'Placement Exclusion']);
      if (dataBl && dataBl.length) {
        dataBl.forEach(function(item) {
          if (item.placement && item.placement.indexOf('youtube.com') === -1) {
            uploadBl.append({ 'Row Type': 'Negative Placement', 'Action': 'Add', 'Placement Exclusion List Name': newListName, 'Placement Exclusion': item.placement, 'Customer ID': '', 'Placement Exclusion List ID': '' });
            if (!maxSyncBl || item.created_at > maxSyncBl) maxSyncBl = item.created_at;
          }
        });
        uploadBl.apply(); api('patch', 'account_registry?uid=eq.' + ctx.cleanId, { blacklist_synced_at: maxSyncBl }, ctx);
      }
    }
  }

  function syncAgeDemographics_(ctx) {
    var adGroups = AdsApp.adGroups().withCondition('Status = ENABLED').get();
    while (adGroups.hasNext()) {
      var agId = adGroups.next().getId();
      ['AGE_RANGE_45_54', 'AGE_RANGE_UNDETERMINED'].forEach(function(age) {
        try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/'+ctx.cleanId+'/adGroups/'+agId, negative: true, ageRange: { type: age } } } }); } catch(e) {}
      });
    }
  }

  function revertCampaignsToCpc_() {
    var camps = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (camps.hasNext()) { var c = camps.next(); if (c.bidding().getStrategyType() !== 'MANUAL_CPC') try { c.bidding().setStrategy('MANUAL_CPC'); } catch(e){} }
  }

  function syncUnpauseFromRegistry_(ctx) {
    var data = api('get', 'account_registry?uid=eq.' + ctx.cleanId, null, ctx);
    if (data && data.length && data[0].needs_unpause_groups) {
      var camps = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
      while (camps.hasNext()) { var ags = camps.next().adGroups().withCondition('Status = PAUSED').get(); while (ags.hasNext()) ags.next().enable(); }
      api('patch', 'account_registry?uid=eq.' + ctx.cleanId, { needs_unpause_groups: false }, ctx);
    }
  }

  function ensureConversionAction_(ctx) {
    if (!AdsApp.search("SELECT conversion_action.id FROM conversion_action WHERE conversion_action.name = '"+ctx.config.CONVERSION_NAME+"'").hasNext()) {
      try { AdsApp.mutate({ conversionActionOperation: { create: { name: ctx.config.CONVERSION_NAME, type: 'UPLOAD_CLICKS', category: 'PURCHASE', status: 'ENABLED' } } }); } catch(e){}
    }
  }

  function maybeCreateDefaultAdGroup_(ctx) {
    var cIter = AdsApp.campaigns().withCondition('Name = "'+ctx.targetCamp+'"').withCondition('Status != REMOVED').get();
    if (cIter.hasNext()) {
      var camp = cIter.next();
      if (!camp.adGroups().withCondition("Name = 'Topic_All'").withCondition("Status != REMOVED").get().hasNext()) {
        var bid = (ctx.targetCamp === 'Display-2') ? 0.01 : 0.02;
        var res = camp.newAdGroupBuilder().withName('Topic_All').withCpc(bid).build();
        if (res.isSuccessful()) {
          var agId = res.getResult().getId();
          ['AGE_RANGE_18_24', 'AGE_RANGE_25_34', 'AGE_RANGE_35_44'].forEach(function(age) {
            try { AdsApp.mutate({ adGroupCriterionOperation: { create: { adGroup: 'customers/'+ctx.cleanId+'/adGroups/'+agId, negative: true, ageRange: { type: age } } } }); } catch(e){}
          });
        }
      }
    }
  }

  function excludeYoutube_() {
    var camps = AdsApp.campaigns().withCondition('Status = ENABLED').withCondition('CampaignType = DISPLAY').get();
    while (camps.hasNext()) {
      var camp = camps.next();
      ['youtube.com', 'www.youtube.com', 'm.youtube.com'].forEach(function(url) {
        try { if (!camp.display().newPlacementBuilder().withUrl(url).exclude().isSuccessful()) {
          var ags = camp.adGroups().withCondition('Status = ENABLED').get(); while (ags.hasNext()) try { ags.next().display().newPlacementBuilder().withUrl(url).exclude(); } catch(e){}
        }} catch(e){}
      });
    }
  }

  function uploadConversionsFromEdge_(ctx) {
    var data = api('get', '/functions/v1/fetch-postbacks?uid=' + ctx.cleanId, null, ctx);
    if (!data || !data.conversions || !data.conversions.length) return;
    var upload = AdsApp.bulkUploads().newCsvUpload(['Google Click ID', 'Conversion Name', 'Conversion Time', 'Conversion Value', 'Conversion Currency']);
    upload.forOfflineConversions();
    var upIds = [];
    data.conversions.forEach(function(c) {
      if (c.gclid && (c.account_uid||'').replace(/-/g,'') === ctx.cleanId) {
        upload.append({ 'Google Click ID': c.gclid, 'Conversion Name': ctx.config.CONVERSION_NAME, 'Conversion Time': c.external_timestamp ? c.external_timestamp.replace('T', ' ')+'+0100' : '', 'Conversion Value': c.payout || 0, 'Conversion Currency': c.currency || 'USD' });
        upIds.push(c.id);
      }
    });
    if (upIds.length) { upload.apply(); api('post', '/functions/v1/fetch-postbacks', { ids: upIds }, ctx); }
  }

  function createAdFromRegistry_(ctx) {
    var tasks = api('get', 'display_ads_registry?account_id=eq.'+ctx.cleanId+'&needs_create=eq.true&limit=5', null, ctx);
    if (!tasks) return;
    tasks.forEach(function(t) {
      try {
        var ags = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignName = "'+ctx.targetCamp+'"').get();
        if (!ags.hasNext()) throw new Error('No active groups in ' + ctx.targetCamp);

        var ts = new Date().getTime().toString().substring(7), sq = [], rect = [];
        getUnq(t.square_image_urls || [t.square_image_url || t.img_square]).forEach(function(u, i) { try { var r = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(u).getBlob()).withName('S_'+ts+'_'+i).build(); if (r.isSuccessful()) sq.push(r.getResult()); } catch(e){} });
        getUnq(t.landscape_image_urls || [t.rectangle_image_url || t.img_rect]).forEach(function(u, i) { try { var r = AdsApp.adAssets().newImageAssetBuilder().withData(UrlFetchApp.fetch(u).getBlob()).withName('R_'+ts+'_'+i).build(); if (r.isSuccessful()) rect.push(r.getResult()); } catch(e){} });
        if (!sq.length || !rect.length) throw new Error('Img fail');
        Utilities.sleep(4000);

        while (ags.hasNext()) {
          var b = ags.next().newAd().responsiveDisplayAdBuilder().withBusinessName(str(t.business_name, 25, 'MB')).withFinalUrl(t.final_url).withLongHeadline(str(t.long_headline, 90, 'H'));
          var hl = getUnq(t.headlines || [t.headline]), dl = getUnq(t.descriptions || [t.description]);
          for (var i=0; i<Math.min(hl.length, 5); i++) b.addHeadline(str(hl[i], 30, 'H'));
          for (var i=0; i<Math.min(dl.length, 5); i++) b.addDescription(str(dl[i], 90, 'D'));
          sq.forEach(function(a){ b.addSquareMarketingImage(a); }); rect.forEach(function(a){ b.addMarketingImage(a); });
          if (sq.length) b.addLogoImage(sq[0]); b.build();
        }
        api('delete', 'display_ads_registry?ad_id=eq.' + encodeURIComponent(t.ad_id), null, ctx);
      } catch(e) { api('patch', 'display_ads_registry?ad_id=eq.' + encodeURIComponent(t.ad_id), { needs_create: false, error_message: e.message.substring(0, 200) }, ctx); }
    });
  }

  function syncAdsToRegistry_(ctx) {
    var ads = AdsApp.ads().withCondition('CampaignType = DISPLAY').withCondition('Status IN [ENABLED, PAUSED]').get(), batch = [];
    while (ads.hasNext()) {
      var ad = ads.next(), st = ad.getStatsFor('TODAY');
      batch.push({ ad_id: ad.getId().toString(), account_id: ctx.cleanId, campaign_name: ad.getCampaign().getName(), type: ad.getType(), final_url: ad.urls().getFinalUrl() || '', clicks: st.getClicks(), cost: st.getCost(), status: ad.isPaused() ? 'PAUSED' : 'ENABLED', updated_at: new Date().toISOString() });
      if (batch.length >= 50) { api('post', 'display_ads_registry', batch, ctx, 'resolution=merge-duplicates'); batch = []; }
    }
    if (batch.length) api('post', 'display_ads_registry', batch, ctx, 'resolution=merge-duplicates');
  }

  function syncAssetPerformance_(ctx) {
    var rows = AdsApp.report("SELECT asset.id, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, ad_group_ad_asset_view.field_type, metrics.clicks, metrics.impressions, metrics.cost_micros FROM ad_group_ad_asset_view WHERE metrics.impressions > 0").rows();
    var data = {}, payload = [];
    while (rows.hasNext()) {
      var r = rows.next(), id = r['asset.id'];
      if (!data[id]) data[id] = { account_id: ctx.cleanId, asset_id: id, asset_text: r['asset.text_asset.text'] || r['asset.image_asset.full_size.url'], field_type: r['ad_group_ad_asset_view.field_type'], clicks: 0, impressions: 0, cost: 0 };
      data[id].clicks += parseInt(r['metrics.clicks']); data[id].impressions += parseInt(r['metrics.impressions']); data[id].cost += parseFloat(r['metrics.cost_micros'])/1000000;
    }
    for (var k in data) payload.push(data[k]);
    if (payload.length) for(var i=0; i<payload.length; i+=50) api('post', 'asset_performance', payload.slice(i, i+50), ctx, 'resolution=merge-duplicates');
  }

  function syncBidsFromRegistry_(ctx) {
    var data = api('get', 'account_registry?uid=eq.' + ctx.cleanId, null, ctx);
    if (!data || !data.length || !data[0].needs_bid_sync) return;

    var targetBid = (ctx.status === 'WARMUP') ? (data[0].warmup_cpc || 0.01) : (data[0].target_cpc || 0.05);

    var ags = AdsApp.adGroups().withCondition('Status = ENABLED').withCondition('CampaignName = "' + ctx.targetCamp + '"').get();
    while (ags.hasNext()) {
      var ag = ags.next();
      if (ag.getCampaign().bidding().getStrategyType() === 'MANUAL_CPC') {
        ag.bidding().setCpc(targetBid);
      }
    }
    api('patch', 'account_registry?uid=eq.' + ctx.cleanId, { needs_bid_sync: false }, ctx);
  }

  function syncAdEditsFromRegistry_(ctx) {
    var edits = api('get', 'display_ads_registry?account_id=eq.'+ctx.cleanId+'&needs_sync=eq.true', null, ctx);
    if (!edits) return;
    edits.forEach(function(e) {
      var it = AdsApp.ads().withCondition('Id = ' + e.ad_id).get();
      if (it.hasNext()) {
        var ad = it.next();
        if (e.target_status === 'REMOVED') { ad.remove(); api('delete', 'display_ads_registry?ad_id=eq.' + e.ad_id, null, ctx); }
        else {
          if (e.target_status === 'ENABLED') ad.enable(); else if (e.target_status === 'PAUSED') ad.pause();
          if (e.edit_final_url) ad.urls().setFinalUrl(e.edit_final_url);
          api('patch', 'display_ads_registry?ad_id=eq.' + e.ad_id, { needs_sync: false }, ctx);
        }
      }
    });
  }

  function checkSafetyLimitsStrict_(ctx) {
    if (ctx.acc.getStatsFor('TODAY').getCost() >= (ctx.config.SAFETY_LIMIT + ctx.config.EXTRA_LIMIT)) {
      var camps = AdsApp.campaigns().withCondition('Status = ENABLED').get();
      while (camps.hasNext()) { var c = camps.next(), ads = c.ads().get(); while (ads.hasNext()) ads.next().remove(); c.pause(); }
    }
  }

  function api(method, route, payload, ctx, prefer) {
    var headers = { 'apikey': ctx.config.SUPABASE_KEY, 'Authorization': 'Bearer ' + ctx.config.SUPABASE_KEY, 'Content-Type': 'application/json' };
    if (prefer) headers['Prefer'] = prefer;
    var res = UrlFetchApp.fetch(ctx.config.SUPABASE_URL + (route.indexOf('/') === 0 ? route : '/rest/v1/' + route), { method: method, headers: headers, payload: payload ? JSON.stringify(payload) : null, muteHttpExceptions: true });
    return (method === 'get' && res.getResponseCode() === 200) ? JSON.parse(res.getContentText()) : null;
  }
  function str(v, l, f) { return (v && String(v).trim()) ? String(v).substring(0, l) : f; }
  function getUnq(a) { var u = []; if(!a) return u; for(var i=0; i<a.length; i++) if((a[i]||'').trim() && u.indexOf((a[i]||'').trim())===-1) u.push((a[i]||'').trim()); return u; }
}
