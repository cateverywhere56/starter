---
title: "Virtual Fitting Room: Generating Arbitrarily Long Videos of Virtual   Try-On from a Single Image -- Technical Preview"
date: "2025-09-04T17:59:55.000Z"
publishedDate: "4 septembre 2025"
summary: "We introduce the Virtual Fitting Room (VFR), a novel video generative model that produces arbitrarily long virtual try-on videos. Our VFR models long video generation tasks as an auto-regressive, segment-by-segment generation process, eliminating the need for resource-intensive generation and lengthy video data, while providing the flexibility to generate videos of arbitrary length."
importance: ""
sourceUrl: "http://arxiv.org/abs/2509.04450v1"
tags: ["cs.CV", "cs.LG"]
permalink: "/papers/2025-09-04-virtual-fitting-room-generating-arbitrarily-long-videos-of-virtual-try-on-from-a-single-image-technical-preview"
---

> Jun-Kun Chen, Aayush Bansal, Minh Phuoc Vo, Yu-Xiong Wang

## TL;DR

We introduce the Virtual Fitting Room (VFR), a novel video generative model that produces arbitrarily long virtual try-on videos. Our VFR models long video generation tasks as an auto-regressive, segment-by-segment generation process, eliminating the need for resource-intensive generation and lengthy video data, while providing the flexibility to generate videos of arbitrary length.

## Abstract (arXiv)

We introduce the Virtual Fitting Room (VFR), a novel video generative model that produces arbitrarily long virtual try-on videos. Our VFR models long video generation tasks as an auto-regressive, segment-by-segment generation process, eliminating the need for resource-intensive generation and lengthy video data, while providing the flexibility to generate videos of arbitrary length. The key challenges of this task are twofold: ensuring local smoothness between adjacent segments and maintaining global temporal consistency across different segments. To address these challenges, we propose our VFR framework, which ensures smoothness through a prefix video condition and enforces consistency with the anchor video -- a 360-degree video that comprehensively captures the human's wholebody appearance. Our VFR generates minute-scale virtual try-on videos with both local smoothness and global temporal consistency under various motions, making it a pioneering work in long virtual try-on video generation.
