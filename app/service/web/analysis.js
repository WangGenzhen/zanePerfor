/* eslint-disable */
'use strict';

const Service = require('egg').Service;

class AnalysisService extends Service {

    // 用户漏斗分析列表
    async getAnalysislist(appId, beginTime, endTime, ip, pageNo, pageSize) {
        pageNo = pageNo * 1;
        pageSize = pageSize * 1;

        const query = { $match: { app_id: appId }, };
        if (ip) query.$match.ip = ip;
        if (beginTime && endTime) query.$match.create_time = { $gte: new Date(beginTime), $lte: new Date(endTime) };

        return ip ? await this.oneThread(query, pageNo, pageSize)
            : await this.moreThread(appId, beginTime, endTime, query, pageNo, pageSize);
    }

    // 平均求值数多线程
    async moreThread(appId, beginTime, endTime, queryjson, pageNo, pageSize) {
        const result = [];
        let distinct = await this.ctx.model.Web.WebEnvironment.distinct('mark_user', queryjson.$match).exec() || [];
        let copdistinct = distinct;

        const betinIndex = (pageNo - 1) * pageSize;
        if (distinct && distinct.length) {
            distinct = distinct.slice(betinIndex, betinIndex + pageSize);
        }
        const resolvelist = [];
        for (let i = 0, len = distinct.length; i < len; i++) {
            resolvelist.push(
                Promise.resolve(
                    this.ctx.model.Web.WebEnvironment.aggregate([
                        { $match: { app_id: appId, mark_user: distinct[i], create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) } } },
                        {
                            $group: {
                                _id: {
                                    ip: "$ip",
                                    markuser: "$mark_user",
                                    browser: "$browser",
                                    system: "$system",
                                },
                            }
                        },
                    ]).exec()
                )
            )
        }
        const all = await Promise.all(resolvelist) || [];
        all.forEach(item => {
            result.push(item[0]);
        })

        return {
            datalist: result,
            totalNum: copdistinct.length,
            pageNo: pageNo,
        };
    }

    // 单个api接口查询平均信息
    async oneThread(queryjson, pageNo, pageSize) {
        const count = Promise.resolve(this.ctx.model.Web.WebEnvironment.distinct('mark_user', queryjson.$match).exec());
        const datas = Promise.resolve(
            this.ctx.model.Web.WebEnvironment.aggregate([
                queryjson,
                {
                    $group: {
                        _id: {
                            ip: "$ip",
                            markuser: "$mark_user",
                            browser: "$browser",
                            system: "$system",
                        },
                    }
                },
                { $skip: (pageNo - 1) * pageSize },
                { $sort: { count: -1 } },
                { $limit: pageSize },
            ]).exec()
        );
        const all = await Promise.all([count, datas]);
        return {
            datalist: all[1],
            totalNum: all[0].length,
            pageNo: pageNo,
        };
    }

    // 单个用户行为轨迹列表
    async getAnalysisOneList(appId, markuser) {
        return await this.ctx.model.Web.WebEnvironment.find({ app_id: appId, mark_user: markuser }).sort({cerate_time:1}) || {};
    }

    // TOP datas
    async getTopDatas(appId, beginTime, endTime, type) {
        type = type * 1;
        let result = {};
        if (type === 1){
            const pages = Promise.resolve(this.getRealTimeTopPages(appId, beginTime, endTime));
            const jump = Promise.resolve(this.getRealTimeTopJumpOut(appId, beginTime, endTime));
            const all = await Promise.all([pages, jump]);
            result = { top_pages: all[0], top_jump_out: all[1] }
        } else if (type === 2) {
            result = await this.getDbTopPages(appId, beginTime, endTime) || {};
        }
        return result;    
    };
    // 历史 top
    async getDbTopPages(appId, beginTime, endTime) {
        let data = await this.ctx.model.Web.WebStatis.findOne({ app_id: appId, create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) } }).exec();
        if (data) return data;
        // 不存在则储存
        return await this.saveRealTimeTopTask(appId, 2, beginTime, endTime)
    }
    // top 页面
    async getRealTimeTopPages(appId, beginTime, endTime) {
        let result = await this.app.redis.get(`${appId}_top_pages_realtime`);
        result = result ? JSON.parse(result) : await this.getRealTimeTopPagesForDb(appId, beginTime, endTime);
        return result;
    }
    async getRealTimeTopPagesForDb(appId, beginTime, endTime, type) {
        const result = await this.ctx.model.Web.WebPages.aggregate([
            { $match: { app_id: appId, create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) }, }, },
            {
                $group: {
                    _id: { url: "$url", },
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
            { $limit: this.app.config.top_alalysis_size.web || 10 },
        ]).exec();
        // 每分钟执行存储到redis
        if (type === 1) this.app.redis.set(`${appId}_top_pages_realtime`, JSON.stringify(result));
        return result;
    }
    // top跳出率
    async getRealTimeTopJumpOut(appId, beginTime, endTime) {
        let result = await this.app.redis.get(`${appId}_top_jump_out_realtime`);
        result = result ? JSON.parse(result) : await this.getRealTimeTopJumpOutForDb(appId, beginTime, endTime);
        return result;
    }
    async getRealTimeTopJumpOutForDb(appId, beginTime, endTime, type) {
        const option = {
            map: function () { emit(this.mark_user, this.url); },
            reduce: function (key, values) {
                return values.length === 1;
            },
            query: { app_id: appId, create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) } },
            out: { replace: 'collectionName' },
        }
        const res = await this.ctx.model.Web.WebEnvironment.mapReduce(option)
        const result = await res.model.aggregate([
            { $match: { value: { $ne: false } } },
            {
                $group: {
                    _id: { value: "$value", },
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
            { $limit: this.app.config.top_alalysis_size.web || 10 },
        ]).exec();
        if (type === 1) this.app.redis.set(`${appId}_top_jump_out_realtime`, JSON.stringify(result));
        return result;
    }

    // top排行榜 Task任务
    async saveRealTimeTopTask(appId, type, begin, end) {
        const beginTime = begin || this.app.format(new Date(), 'yyyy/MM/dd') + ' 00:00:00';
        const endTime = end || new Date();

        const pages = Promise.resolve(this.getRealTimeTopPagesForDb(appId, beginTime, endTime, type));
        const jump = Promise.resolve(this.getRealTimeTopJumpOutForDb(appId, beginTime, endTime, type));
        if (type === 2) {
            // 每天数据存储到数据库
            const provinces = Promise.resolve(this.getProvinceAvgCountForDb(appId, beginTime, endTime, type));
            const all = await Promise.all([pages, jump, provinces]);

            const statis = this.ctx.model.Web.WebStatis();
            statis.app_id = appId;
            statis.top_pages = all[0];
            statis.top_jump_out = all[1];
            statis.provinces = all[2];
            statis.create_time = beginTime;
            return await statis.save();
        }
    }

    // 省份流量统计
    async getProvinceAvgCount(appId, beginTime, endTime, type) {
        let result = null;
        type = type * 1;
        if(type === 1) {
            result = await this.getProvinceAvgCountForDb(appId, beginTime, endTime, type);
        } else if (type === 2) {
            // 先查询是否存在
            let data = await this.ctx.model.Web.WebStatis.findOne({ app_id: appId, create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) } }).exec();
            // 不存在则储存
            result = data ? data : await this.saveRealTimeTopTask(appId, 2, beginTime, endTime);
        }
        return result
    }

    async getProvinceAvgCountForDb(appId, beginTime, endTime, type) {
        const result = await this.ctx.model.Web.WebEnvironment.aggregate([
            { $match: { app_id: appId, create_time: { $gte: new Date(beginTime), $lte: new Date(endTime) } } },
            {
                $group: {
                    _id: { province: "$province", },
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1 } },
        ]).exec();
        return type === 1 ? { provinces: result } : result;
    }

}

module.exports = AnalysisService;
